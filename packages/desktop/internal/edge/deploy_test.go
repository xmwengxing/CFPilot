package edge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

func d1TestClient(t *testing.T, handler http.HandlerFunc) *cfapi.Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return cfapi.New(cfapi.Options{Token: "test-token", APIBase: srv.URL})
}

func writeD1Response(w http.ResponseWriter, status int, success bool) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": success, "result": []any{}, "errors": []any{}})
}

func TestSplitSQL(t *testing.T) {
	sql := `-- 注释行
CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY);
-- 第二条注释
CREATE INDEX idx ON devices(id);`
	stmts := splitSQL(sql)
	if len(stmts) != 2 {
		t.Fatalf("应拆出 2 条，实际 %d: %v", len(stmts), stmts)
	}
	if !strings.Contains(stmts[0], "CREATE TABLE") || strings.Contains(stmts[0], "--") {
		t.Errorf("第一条应保留 CREATE 且剥掉注释：%q", stmts[0])
	}
	if !strings.Contains(stmts[1], "CREATE INDEX") {
		t.Errorf("第二条应为 CREATE INDEX：%q", stmts[1])
	}
}

func TestSplitSchemaAsset(t *testing.T) {
	raw, err := assets.ReadFile("assets/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	stmts := splitSQL(string(raw))
	if len(stmts) != 5 {
		t.Fatalf("内置 schema 应拆出 5 条语句，实际 %d", len(stmts))
	}
	joined := strings.Join(stmts, "\n")
	for _, want := range []string{"devices", "idx_devices_last_seen", "auth", "sessions", "idx_sessions_expires"} {
		if !strings.Contains(joined, want) {
			t.Errorf("schema 缺少 %s", want)
		}
	}
}

func TestInitializeD1SchemaWaitsForDatabaseAndRetriesTransientSchemaError(t *testing.T) {
	readinessAttempts := 0
	schemaAttempts := 0
	client := d1TestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/accounts/account/d1/database/database/query" {
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var body struct {
			SQL string `json:"sql"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode query: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if body.SQL == "SELECT 1" {
			readinessAttempts++
			if readinessAttempts == 1 {
				writeD1Response(w, http.StatusServiceUnavailable, false)
				return
			}
		} else {
			schemaAttempts++
			if schemaAttempts == 1 {
				writeD1Response(w, http.StatusTooManyRequests, false)
				return
			}
		}
		writeD1Response(w, http.StatusOK, true)
	})

	var progress []string
	err := initializeD1Schema(context.Background(), client, "account", "database", []string{"CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY)"}, func(s string) {
		progress = append(progress, s)
	})
	if err != nil {
		t.Fatalf("initializeD1Schema returned error: %v", err)
	}
	if readinessAttempts != 2 {
		t.Errorf("readiness attempts = %d, want 2", readinessAttempts)
	}
	if schemaAttempts != 2 {
		t.Errorf("schema attempts = %d, want 2", schemaAttempts)
	}
	if len(progress) < 3 || !strings.Contains(strings.Join(progress, " "), "重试") {
		t.Errorf("expected readiness and retry progress messages, got %v", progress)
	}
}

func TestInitializeD1SchemaDoesNotRetryPermanentErrors(t *testing.T) {
	attempts := 0
	client := d1TestClient(t, func(w http.ResponseWriter, r *http.Request) {
		attempts++
		writeD1Response(w, http.StatusBadRequest, false)
	})
	err := initializeD1Schema(context.Background(), client, "account", "database", []string{"CREATE TABLE x"}, nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("expected permanent API error, got %v", err)
	}
	if attempts != 1 {
		t.Errorf("attempts = %d, want 1", attempts)
	}
}

func TestInitializeD1SchemaHonorsCanceledContext(t *testing.T) {
	client := d1TestClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeD1Response(w, http.StatusServiceUnavailable, false)
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	err := initializeD1Schema(ctx, client, "account", "database", []string{"CREATE TABLE x"}, nil)
	if err == nil || !strings.Contains(err.Error(), "取消") {
		t.Fatalf("expected canceled operation, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("canceled initialization should return promptly")
	}
}

func TestSetupMonitorPasswordRetriesUntilWorkerIsReady(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/setup" {
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		attempts++
		if attempts == 1 {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	alreadySetup, err := setupMonitorPassword(context.Background(), srv.URL, "password123", nil)
	if err != nil {
		t.Fatalf("setupMonitorPassword returned error: %v", err)
	}
	if alreadySetup {
		t.Fatal("fresh setup should not report existing password")
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
}

func TestSetupMonitorPasswordConflictIsIdempotent(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusConflict)
	}))
	defer srv.Close()

	alreadySetup, err := setupMonitorPassword(context.Background(), srv.URL, "password123", nil)
	if err != nil || !alreadySetup {
		t.Fatalf("409 should be idempotent success, alreadySetup=%v err=%v", alreadySetup, err)
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}

func TestQueryD1WithRetryBoundsInFlightRequestByDeadline(t *testing.T) {
	attempts := 0
	client := d1TestClient(t, func(w http.ResponseWriter, r *http.Request) {
		attempts++
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	})
	deadline := time.Now().Add(50 * time.Millisecond)
	start := time.Now()
	err := queryD1WithRetry(context.Background(), client, "account", "database", "SELECT 1", deadline, "D1 就绪检查", nil)
	if err == nil || !strings.Contains(err.Error(), "90 秒内未完成") {
		t.Fatalf("expected deadline error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("request exceeded deadline: %s", elapsed)
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}

func TestReplaceDefaultAPI(t *testing.T) {
	for _, html := range []string{
		"<script>const DEFAULT_API = 'https://relay.shijingtian.de5.net';</script>",
		"<script>const DEFAULT_API = location.origin;</script>",
	} {
		got := replaceDefaultAPI(html, "https://relay.example.com")
		if !strings.Contains(got, "const DEFAULT_API = 'https://relay.example.com'") {
			t.Errorf("未替换默认 API：%s", got)
		}
		if strings.Contains(got, "shijingtian") {
			t.Errorf("旧默认 API 仍残留：%s", got)
		}
	}
}

func TestZoneNameFromDomain(t *testing.T) {
	cases := map[string]string{
		"relay.example.com": "example.com",
		"a.b.Example.COM":   "example.com",
		"example.com":       "example.com",
	}
	for in, want := range cases {
		if got := zoneNameFromDomain(in); got != want {
			t.Errorf("zoneNameFromDomain(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestRandomHex(t *testing.T) {
	a, b := randomHex(24), randomHex(24)
	if len(a) != 48 || len(b) != 48 {
		t.Errorf("24 字节应编码为 48 hex，实际 %d/%d", len(a), len(b))
	}
	if a == b {
		t.Error("两次随机令牌不应相同")
	}
}

func TestEmbeddedAssets(t *testing.T) {
	for _, name := range []string{"assets/worker.js", "assets/dashboard.html", "assets/schema.sql"} {
		b, err := assets.ReadFile(name)
		if err != nil {
			t.Errorf("缺少内置资产 %s: %v", name, err)
			continue
		}
		if len(b) < 100 {
			t.Errorf("资产 %s 过小（%d B）", name, len(b))
		}
	}
	code, _ := assets.ReadFile("assets/worker.js")
	if !strings.Contains(string(code), "export") {
		t.Error("worker.js 应含 export（ES module）")
	}
	if !strings.Contains(string(code), "dashboard_default") || !strings.Contains(string(code), "DEFAULT_API") {
		t.Error("worker.js 应在根路径提供云监测台页面")
	}
}
