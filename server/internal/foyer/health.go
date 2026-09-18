package foyer

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

func RedactMetaURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	if _, has := u.User.Password(); !has {
		return raw
	}
	u.User = url.UserPassword(u.User.Username(), "***")
	out := u.String()
	// url.String percent-encodes * in passwords; health output uses literal ***.
	return strings.ReplaceAll(out, "%2A%2A%2A", "***")
}

func HealthJSON(cfg Config) []byte {
	b, _ := json.Marshal(map[string]any{
		"ok":      true,
		"volume":  cfg.Volume,
		"gateway": cfg.GatewayListen,
		"meta":    RedactMetaURL(cfg.MetaURL),
	})
	return b
}

func NewHealthMux(cfg Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/foyer/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(HealthJSON(cfg))
	})
	return mux
}
