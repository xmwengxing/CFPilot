package mesh

// UPnP IGD 客户端（WANIPConnection / WANPPPConnection）。
//
// 流程：SSDP 发现设备描述 → 从描述里取 controlURL → SOAP AddPortMapping。
// 描述文档的 XML 解析只用本地名匹配（不依赖命名空间前缀），对国产品牌路由
// 那些不规范的描述文档更宽容。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	upnpDiscoveryTimeout = 3 * time.Second
	upnpHTTPTimeout      = 5 * time.Second
	upnpLeaseSeconds     = 3600
	// UPnP 的老路由器只支持永久租约（错误码 725），拿到永久映射后按 24h 续一次，
	// 只为在「路由器重启 / 映射被清」后能重新申请，不是协议要求。
	upnpPermanentRenew = 24 * time.Hour
	upnpServiceWANIP   = "urn:schemas-upnp-org:service:WANIPConnection:1"
	upnpServiceWANPPP  = "urn:schemas-upnp-org:service:WANPPPConnection:1"
)

// upnpClient 是一个已定位到 controlURL 的 IGD 服务。
type upnpClient struct {
	serviceType string
	controlURL  string
	description string
	http        *http.Client
	// permanent 表示路由器拒绝了有限租约，只能永久映射（错误码 725）。
	permanent bool
}

func (c *upnpClient) protocol() string { return "upnp" }

func (c *upnpClient) client() *http.Client {
	if c.http != nil {
		return c.http
	}
	return &http.Client{Timeout: upnpHTTPTimeout}
}

func (c *upnpClient) Map(ctx context.Context, req portMapRequest) (*portMapping, error) {
	lease := upnpLeaseSeconds
	if c.permanent {
		lease = 0
	}
	in := func(l int) string {
		return fmt.Sprintf("<NewRemoteHost></NewRemoteHost>"+
			"<NewExternalPort>%d</NewExternalPort>"+
			"<NewProtocol>UDP</NewProtocol>"+
			"<NewInternalPort>%d</NewInternalPort>"+
			"<NewInternalClient>%s</NewInternalClient>"+
			"<NewEnabled>1</NewEnabled>"+
			"<NewPortMappingDescription>CFPilot</NewPortMappingDescription>"+
			"<NewLeaseDuration>%d</NewLeaseDuration>",
			req.InternalPort, req.InternalPort, req.InternalIP, l)
	}
	_, err := c.soap(ctx, "AddPortMapping", in(lease))
	if err != nil {
		if f, ok := err.(*upnpFault); ok && (f.Code == 725 || f.Code == 402) {
			// 725 = 只支持永久租约；402 = 参数非法（部分老固件对租约参数报这个）。
			if _, err2 := c.soap(ctx, "AddPortMapping", in(0)); err2 == nil {
				c.permanent = true
				lease = 0
				err = nil
			}
		}
	}
	if err != nil {
		return nil, err
	}
	lifetime := time.Duration(lease) * time.Second
	if lifetime <= 0 {
		lifetime = upnpPermanentRenew
	}
	expires := time.Now().Add(lifetime)
	extIP := c.externalIP(ctx)
	return &portMapping{
		Protocol:     c.protocol(),
		Gateway:      c.gateway(),
		ExternalIP:   extIP,
		ExternalPort: req.InternalPort,
		InternalPort: req.InternalPort,
		Lifetime:     lifetime,
		ExpiresAt:    expires,
	}, nil
}

func (c *upnpClient) gateway() string {
	if u, err := parseURL(c.description); err == nil && u != nil {
		return u.Host
	}
	return ""
}

// externalIP 尽力取路由器 WAN 地址；取不到返回 nil（映射仍然有效）。
func (c *upnpClient) externalIP(ctx context.Context) net.IP {
	body, err := c.soap(ctx, "GetExternalIPAddress", "")
	if err != nil {
		return nil
	}
	start := strings.Index(body, "<NewExternalIPAddress>")
	if start < 0 {
		return nil
	}
	start += len("<NewExternalIPAddress>")
	end := strings.Index(body[start:], "</NewExternalIPAddress>")
	if end < 0 {
		return nil
	}
	ip := net.ParseIP(strings.TrimSpace(body[start : start+end]))
	if ip == nil || ip.IsUnspecified() {
		return nil
	}
	return ip
}

type upnpFault struct {
	Code int
	Desc string
}

func (f *upnpFault) Error() string {
	return fmt.Sprintf("UPnP 错误 %d: %s", f.Code, f.Desc)
}

func (c *upnpClient) soap(ctx context.Context, action, inner string) (string, error) {
	env := `<?xml version="1.0"?>` +
		`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
		`s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
		`<u:` + action + ` xmlns:u="` + c.serviceType + `">` + inner +
		`</u:` + action + `></s:Body></s:Envelope>`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.controlURL, strings.NewReader(env))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", `text/xml; charset="utf-8"`)
	req.Header.Set("SOAPACTION", `"`+c.serviceType+"#"+action+`"`)
	resp, err := c.client().Do(req)
	if err != nil {
		return "", fmt.Errorf("SOAP %s 失败: %w", action, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", fmt.Errorf("SOAP %s 读响应失败: %w", action, err)
	}
	if resp.StatusCode != http.StatusOK {
		var fault struct {
			Code int    `xml:"Body>Fault>detail>UPnPError>errorCode"`
			Desc string `xml:"Body>Fault>detail>UPnPError>errorDescription"`
		}
		if xml.Unmarshal(data, &fault) == nil && fault.Code != 0 {
			return "", &upnpFault{Code: fault.Code, Desc: fault.Desc}
		}
		return "", fmt.Errorf("SOAP %s 返回 HTTP %d", action, resp.StatusCode)
	}
	return string(data), nil
}

func parseURL(raw string) (*url.URL, error) { return url.Parse(raw) }

// resolveURL 把 controlURL 解析成绝对地址：相对路径按 URLBase / 描述地址解析。
func resolveURL(base, ref string) (string, error) {
	b, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	r, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	if r.IsAbs() {
		return r.String(), nil
	}
	return b.ResolveReference(r).String(), nil
}

// ---------- 发现 ----------

// discoverUPnPDevice 用 SSDP 找一台 IGD（先 WANIPConnection，再 WANPPPConnection）。
func discoverUPnPDevice(ctx context.Context, localIP net.IP) (*upnpClient, error) {
	var lastErr error = fmt.Errorf("SSDP 未发现 IGD")
	for _, st := range []string{upnpServiceWANIP, upnpServiceWANPPP} {
		locations := ssdpSearch(ctx, st, localIP)
		for _, loc := range locations {
			c, err := newUPnPClientFromDescription(ctx, loc, nil)
			if err != nil {
				lastErr = err
				continue
			}
			return c, nil
		}
	}
	return nil, lastErr
}

// ssdpSearch 发一次 M-SEARCH，收集 LOCATION（去重、保序）。
func ssdpSearch(ctx context.Context, st string, localIP net.IP) []string {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: localIP, Port: 0})
	if err != nil {
		return nil
	}
	defer conn.Close()
	msg := "M-SEARCH * HTTP/1.1\r\n" +
		"HOST: 239.255.255.250:1900\r\n" +
		`MAN: "ssdp:discover"` + "\r\n" +
		"MX: 2\r\n" +
		"ST: " + st + "\r\n\r\n"
	if _, err := conn.WriteToUDP([]byte(msg), &net.UDPAddr{IP: net.IPv4(239, 255, 255, 250), Port: 1900}); err != nil {
		return nil
	}
	deadline := time.Now().Add(upnpDiscoveryTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetReadDeadline(deadline)
	seen := map[string]bool{}
	var out []string
	buf := make([]byte, 2048)
	for {
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			return out
		}
		loc := ssdpHeader(string(buf[:n]), "location")
		if loc == "" || seen[loc] {
			continue
		}
		seen[loc] = true
		out = append(out, loc)
	}
}

func ssdpHeader(resp, name string) string {
	sc := bufio.NewScanner(strings.NewReader(resp))
	for sc.Scan() {
		line := sc.Text()
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(line[:idx]), name) {
			return strings.TrimSpace(line[idx+1:])
		}
	}
	return ""
}

// upnpDescription 只取本文件用到的字段。
type upnpDescription struct {
	XMLName xml.Name `xml:"root"`
	URLBase string   `xml:"URLBase"`
	Device  struct {
		ServiceList struct {
			Services []struct {
				ServiceType string `xml:"serviceType"`
				ControlURL  string `xml:"controlURL"`
			} `xml:"service"`
		} `xml:"serviceList"`
	} `xml:"device"`
}

// newUPnPClientFromDescription 拉取设备描述并挑出第一个可用的 WAN 连接服务。
func newUPnPClientFromDescription(ctx context.Context, descURL string, hc *http.Client) (*upnpClient, error) {
	if hc == nil {
		hc = &http.Client{Timeout: upnpHTTPTimeout}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, descURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("拉取 UPnP 描述失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("拉取 UPnP 描述失败: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if err != nil {
		return nil, err
	}
	var doc upnpDescription
	if err := xml.Unmarshal(bytes.TrimSpace(data), &doc); err != nil {
		return nil, fmt.Errorf("解析 UPnP 描述失败: %w", err)
	}
	base := descURL
	if strings.TrimSpace(doc.URLBase) != "" {
		base = strings.TrimSpace(doc.URLBase)
	}
	for _, svc := range doc.Device.ServiceList.Services {
		st := strings.TrimSpace(svc.ServiceType)
		if st != upnpServiceWANIP && st != upnpServiceWANPPP {
			continue
		}
		ctl := strings.TrimSpace(svc.ControlURL)
		if ctl == "" {
			continue
		}
		abs, err := resolveURL(base, ctl)
		if err != nil {
			continue
		}
		return &upnpClient{serviceType: st, controlURL: abs, description: descURL, http: hc}, nil
	}
	return nil, fmt.Errorf("UPnP 描述里没有 WAN 连接服务")
}
