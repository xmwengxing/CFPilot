//go:build darwin && cfp_gui

package shell

/*
#cgo darwin CFLAGS: -x objective-c -fobjc-arc
#cgo darwin LDFLAGS: -framework Cocoa -framework WebKit

#include <stdbool.h>
#include <stdlib.h>
#include <pthread.h>

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <CoreGraphics/CoreGraphics.h>

// Go 侧导出的回调，定义在 shell_darwin_callback.go。
extern void cfpShellCommandFromJS(char* raw);

static NSString* const kCFPCommandHandlerName = @"cfpilotShellCommand";

@interface CFPanelHost : NSObject <NSWindowDelegate, WKScriptMessageHandler>
@property(nonatomic, strong) NSWindow* window;
@property(nonatomic, strong) WKWebView* webView;
@end

@implementation CFPanelHost

// 用户点红点：收进托盘，不退出程序（与 Windows 版的语义一致）。
// 窗口对象保留，托盘「打开界面」还能把它唤回来。
- (BOOL)windowShouldClose:(NSWindow*)sender {
  [sender orderOut:nil];
  return NO;
}

// 页面里的 window.cfpilotShellCommand(...) → Go。
- (void)userContentController:(WKUserContentController*)controller
      didReceiveScriptMessage:(WKScriptMessage*)message {
  if (![message.name isEqualToString:kCFPCommandHandlerName]) {
    return;
  }
  id body = message.body;
  if (![body isKindOfClass:[NSString class]]) {
    return;
  }
  cfpShellCommandFromJS((char*)[(NSString*)body UTF8String]);
}

// 拆掉消息处理器与视图，准备释放。
// WKUserContentController 会强引用 handler，不 remove 就是循环引用 + 退出前
// 一直挂着已销毁窗口的回调。
- (void)tearDown {
  [self.webView stopLoading];
  [self.webView.configuration.userContentController
      removeScriptMessageHandlerForName:kCFPCommandHandlerName];
  [self.webView setNavigationDelegate:nil];
  [self.window setDelegate:nil];
  [self.window close];
  self.webView = nil;
  self.window = nil;
}

@end

// 单窗口：整个进程只有一个面板窗口，因此只保留一个宿主对象。
static CFPanelHost* gHost = nil;

static void cfpOnMain(void (^block)(void)) {
  if ([NSThread isMainThread]) {
    block();
  } else {
    dispatch_async(dispatch_get_main_queue(), block);
  }
}

bool cfpShellGUIAvailable(void) {
  // 没有 WindowServer 连接（典型场景：SSH 登录的 shell）时返回 NULL。
  // 这种会话里初始化 NSApplication 会把进程挂死，先问一句再决定。
  CFDictionaryRef session = CGSessionCopyCurrentDictionary();
  if (session == NULL) {
    return false;
  }
  CFRelease(session);
  return true;
}

bool cfpShellIsMainThread(void) { return pthread_main_np() != 0; }

bool cfpShellCreate(const char* title, const char* url, const char* script, double width, double height) {
  // Go 侧已经校验过线程，这里只做兜底：不是主线程就直接失败，
  // 让调用方回退浏览器，而不是让 AppKit 抛异常把整个进程带走。
  if (cfpShellIsMainThread() == false || gHost != nil) {
    return false;
  }

  [NSApplication sharedApplication];
  // 有 Dock 图标用户才知道程序在跑；托盘图标另有 systray 负责。
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

  NSRect frame = NSMakeRect(0, 0, width > 320 ? width : 320, height > 240 ? height : 240);

  NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
  NSWindow* window = [[NSWindow alloc] initWithContentRect:frame
                                                 styleMask:style
                                                   backing:NSBackingStoreBuffered
                                                     defer:NO];
  // releasedWhenClosed 必须是 NO：关窗只是隐藏，窗口对象还要复用。
  [window setReleasedWhenClosed:NO];
  [window setTitle:[NSString stringWithUTF8String:title]];
  [window setMinSize:NSMakeSize(900, 600)];
  [window center];

  WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
  WKUserContentController* controller = [[WKUserContentController alloc] init];

  CFPanelHost* host = [[CFPanelHost alloc] init];
  [controller addScriptMessageHandler:host name:kCFPCommandHandlerName];
  // 注入时机必须是文档开始：界面一加载就会读 window.__cfpilotShell，
  // 晚一步就只能靠轮询补，用户会看到「先闪一下浏览器版界面」。
  [controller addUserScript:[[WKUserScript alloc]
                                initWithSource:[NSString stringWithUTF8String:script]
                                 injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                              forMainFrameOnly:YES]];
  [config setUserContentController:controller];

  WKWebView* webView = [[WKWebView alloc] initWithFrame:frame configuration:config];
  [webView setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
  [window setContentView:webView];
  [window setDelegate:host];

  host.window = window;
  host.webView = webView;
  gHost = host;

  NSURL* target = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
  if (target == nil) {
    [host tearDown];
    gHost = nil;
    return false;
  }
  [webView loadRequest:[NSURLRequest requestWithURL:target]];

  [window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  return true;
}

void cfpShellShow(void) {
  cfpOnMain(^{
    if (gHost == nil) {
      return;
    }
    [gHost.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
  });
}

void cfpShellHide(void) {
  cfpOnMain(^{
    if (gHost == nil) {
      return;
    }
    [gHost.window orderOut:nil];
  });
}

void cfpShellEval(const char* script) {
  NSString* js = [NSString stringWithUTF8String:script];
  if (js == nil) {
    return;
  }
  cfpOnMain(^{
    if (gHost == nil) {
      return;
    }
    [gHost.webView evaluateJavaScript:js completionHandler:nil];
  });
}

void cfpShellDestroy(void) {
  cfpOnMain(^{
    if (gHost == nil) {
      return;
    }
    [gHost tearDown];
    gHost = nil;
  });
}
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"
)

// panel 是 macOS 上的实现：系统自带的 WKWebView + Cocoa 原生标题栏。
//
// ## 为什么必须开 cgo
//
// WKWebView / NSWindow / NSStatusItem 全是 Objective-C 对象，没有稳定的 C ABI，
// 纯 Go 只能靠 objc_msgSend 手拼消息（Windows 那套 syscall + LazyDLL 的路子
// 在这里没有对应物）。托盘依赖的 energye/systray 在 darwin 上同样是 cgo，
// 所以 darwin 构建本来就要 CGO_ENABLED=1。
//
// 由此推论：**darwin 产物只能在 macOS 上编**，Windows / Linux 上没有 AppKit，
// 构建脚本里已按宿主平台做守卫。
//
// ## 为什么 Objective-C 写在 cgo 前导代码里，而不是单独的 .m 文件
//
// Go 只要在包目录里看到 .m，就要求整个包用 cgo 构建 —— 而不带 cfp_gui 的
// darwin 构建（纯服务形态）本来就没有 cgo 文件，会直接报
// "Objective-C source files not allowed when not using cgo"，
// 连 `go test ./internal/shell` 都跑不了。
// 放进带 //go:build 的前导代码里，代码随文件一起被标签排除，两侧都干净。
// （反过来，//export 那个文件不能放定义 —— cgo 只允许它带声明。）
//
// ## 为什么窗口必须在主线程创建
//
// AppKit 只允许在主线程创建窗口与视图，而主线程已经被托盘占住了：
// 托盘启动后会在主 goroutine 上调 [NSApp run] 跑消息循环。
// 所以顺序必须是「先 shell.New（主 goroutine、主线程）→ 后 tray.Run」，
// cmd/cfpilot 里就是它；这里再显式校验一次线程，
// 不在主线程就明确回退浏览器，而不是让 AppKit 抛没法诊断的异常。
//
// ## DataDir 在这个平台不生效
//
// WKWebView 的网站数据（Cookie / 缓存）由系统按 bundle id 放在
// ~/Library/WebKit 下，没有 API 能把它指到别处。
// Options.DataDir 因此只对 Windows / Linux 有意义，这里不做「假装支持」。
type panel struct {
	opts Options

	mu   sync.Mutex
	dead bool

	done     chan struct{}
	doneOnce sync.Once
}

// 单窗口约束：一个进程只有一个面板窗口，
// 所以原生侧只保存一个全局宿主对象，Go 侧只记一个当前面板。
var (
	panelMu  sync.Mutex
	curPanel *panel
)

// bridgeShim 把 cfpilotShellCommand 接到 WKWebView 的消息处理器上。
//
// Windows 的 WebView2 与 Linux 的 WebKitGTK 都能把 Go 函数直接绑成页面里的
// 全局函数；WKWebView 没有等价能力，只能走
// window.webkit.messageHandlers.<name>.postMessage。这里补一层同名函数，
// 让 InitScript 与界面代码在三平台上仍是同一份契约
// （界面只认 window.cfpilotShellCommand，不需要知道平台差异）。
const bridgeShim = `(function () {
  if (window.cfpilotShellCommand) return;
  window.cfpilotShellCommand = function (raw) {
    try {
      window.webkit.messageHandlers.cfpilotShellCommand.postMessage(String(raw));
    } catch (e) { /* 桥不可用时静默降级，与 Windows / Linux 一致 */ }
  };
})();`

// New 创建 macOS 面板窗口。
//
// 没有图形会话（SSH、无 WindowServer）或不在主线程时返回 ErrUnsupported，
// 调用方回退到系统浏览器 —— 服务本身照常运行。
func New(opts Options) (Panel, error) {
	if opts.URL == "" {
		return nil, errors.New("缺少面板地址")
	}
	if opts.Title == "" {
		opts.Title = "CFPilot 部署与网络维护"
	}
	if opts.Width <= 0 {
		opts.Width = 1180
	}
	if opts.Height <= 0 {
		opts.Height = 820
	}

	// SSH 会话里没有 WindowServer 连接，建窗口会把进程直接拖死在 AppKit 里。
	// 先问一句，拿到明确的「不支持」比事后排查崩溃日志省事得多。
	if !bool(C.cfpShellGUIAvailable()) {
		opts.logf("[shell] 当前会话没有图形界面（SSH / 无 WindowServer）")
		return nil, fmt.Errorf("%w：没有图形会话", ErrUnsupported)
	}
	if !bool(C.cfpShellIsMainThread()) {
		opts.logf("[shell] 窗口创建不在主线程（托盘消息循环占用主线程）")
		return nil, fmt.Errorf("%w：窗口必须在主线程创建", ErrUnsupported)
	}

	title := C.CString(opts.Title)
	url := C.CString(opts.URL)
	script := C.CString(bridgeShim + InitScript("darwin", ChromeNative))
	defer C.free(unsafe.Pointer(title))
	defer C.free(unsafe.Pointer(url))
	defer C.free(unsafe.Pointer(script))

	if !bool(C.cfpShellCreate(title, url, script, C.double(opts.Width), C.double(opts.Height))) {
		opts.logf("[shell] WKWebView 窗口创建失败")
		return nil, fmt.Errorf("%w：WKWebView 窗口创建失败", ErrUnsupported)
	}

	p := &panel{opts: opts, done: make(chan struct{})}
	panelMu.Lock()
	curPanel = p
	panelMu.Unlock()

	opts.logf("[shell] 面板窗口已创建（WKWebView，macOS 原生标题栏）")
	return p, nil
}

// ActivateExisting 在 macOS 上不支持唤醒**另一个进程**的窗口。
//
// Windows 能用 FindWindow 跨进程找窗口并置前，macOS 没有对等能力：
// 实现得走 AppleScript / 辅助功能授权，代价是每次启动弹一次系统授权框，
// 明显不划算。返回 false，调用方按「端口被占用」提示用户即可。
func ActivateExisting(string) bool { return false }

func (p *panel) Platform() string { return "darwin" }

// Chrome 返回原生标题栏：macOS 的窗口装饰由系统绘制，
// 面板据此隐藏自己画的 HTML 标题栏，避免两层标题。
func (p *panel) Chrome() ChromeMode { return ChromeNative }

func (p *panel) Wait() { <-p.done }

// Show 显示并置前窗口（窗口关掉后仍可复用：关窗只是收进托盘）。
func (p *panel) Show(page string) bool {
	p.mu.Lock()
	dead := p.dead
	p.mu.Unlock()
	if dead {
		return false
	}

	C.cfpShellShow()

	if page = sanitizePage(page); page != "" {
		js := C.CString(pageScript(page))
		defer C.free(unsafe.Pointer(js))
		C.cfpShellEval(js)
	}
	return true
}

// Hide 把窗口收起来（等同用户点关闭按钮，服务继续在托盘里跑）。
func (p *panel) Hide() {
	p.mu.Lock()
	dead := p.dead
	p.mu.Unlock()
	if dead {
		return
	}
	C.cfpShellHide()
}

// Close 销毁窗口。
//
// 不能阻塞：托盘点「退出」时会先调它再 os.Exit，
// 而销毁动作是投递到主队列执行的（WKWebView 的释放只能在主线程）。
func (p *panel) Close() {
	p.mu.Lock()
	dead := p.dead
	p.dead = true
	p.mu.Unlock()
	if dead {
		return
	}

	C.cfpShellDestroy()

	panelMu.Lock()
	if curPanel == p {
		curPanel = nil
	}
	panelMu.Unlock()

	p.doneOnce.Do(func() { close(p.done) })
}

// handleCommand 处理页面桥命令。
//
// macOS 用原生标题栏，最小化 / 最大化 / 关闭由系统接管，
// 所以只需要「外部链接」和「关闭」两条 —— 与 Linux 版同口径。
func (p *panel) handleCommand(raw string) string {
	c, err := decodeCommand(raw)
	if err != nil {
		p.opts.logf("[shell] 忽略非法命令：%v", err)
		return ""
	}
	switch c.Cmd {
	case CmdOpenExternal:
		if !externalAllowed(c.URL) {
			p.opts.logf("[shell] 拒绝打开非 https 链接")
			return ""
		}
		if p.opts.OpenExternal != nil {
			if err := p.opts.OpenExternal(c.URL); err != nil {
				p.opts.logf("[shell] 打开外部链接失败：%v", err)
			}
		}
	case CmdClose:
		p.Hide()
	default:
		// 拖动 / 最小化 / 最大化由窗口管理器接管，不需要桥。
	}
	return ""
}
