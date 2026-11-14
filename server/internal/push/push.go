// Package push wakes a recipient's device through its UnifiedPush endpoint.
//
// The request carries no content at all: the device's distributor (e.g. ntfy) only
// learns "something arrived for this endpoint", and the Mayfly app shows its own
// notification. Nothing about the sender or the moment leaves this server.
package push

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"syscall"
	"time"
)

var allowPrivate = os.Getenv("PUSH_ALLOW_PRIVATE") == "1" || os.Getenv("NTFY_ALLOW_PRIVATE") == "1"

const MaxEndpointLen = 1024

// ValidateEndpoint accepts only absolute https URLs without credentials or fragments.
func ValidateEndpoint(raw string) error {
	if raw == "" {
		return nil
	}
	if len(raw) > MaxEndpointLen {
		return errors.New("push endpoint too long")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return errors.New("push endpoint must be an https:// URL")
	}
	return nil
}

// Other ranges that never are a public push server: "this network", CGNAT, protocol
// assignments, benchmarking, reserved, and IPv6 prefixes that embed an IPv4 address
// (NAT64, 6to4, Teredo) and could lead back into a private network.
var blockedNets = mustCIDRs(
	"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
	"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
	"64:ff9b::/96", "64:ff9b:1::/48", "2001::/32", "2001:db8::/32", "2002::/16",
)

func mustCIDRs(list ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(list))
	for _, c := range list {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(err)
		}
		out = append(out, n)
	}
	return out
}

func isBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return true
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// SSRF guard: refuse internal addresses at connect time (after DNS resolution, so
// DNS rebinding does not help) and never follow redirects.
var client = &http.Client{
	Timeout: 8 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
	Transport: &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout: 5 * time.Second,
			Control: func(network, address string, _ syscall.RawConn) error {
				if allowPrivate {
					return nil
				}
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return err
				}
				ip := net.ParseIP(host)
				if ip == nil || isBlockedIP(ip) {
					return fmt.Errorf("push: refusing to connect to %s", host)
				}
				return nil
			},
		}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		MaxIdleConns:          20,
	},
}

// Wake sends an empty push to the endpoint. Returns gone=true when the push server
// says the endpoint no longer exists (404/410), so the caller can forget it.
func Wake(endpoint string) (gone bool, err error) {
	if endpoint == "" {
		return false, nil
	}
	if err := ValidateEndpoint(endpoint); err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, http.NoBody)
	if err != nil {
		return false, err
	}
	// Web Push style headers (understood by ntfy, NextPush, autopush-based servers)
	req.Header.Set("TTL", "86400")
	req.Header.Set("Urgency", "high")
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return true, nil
	}
	if resp.StatusCode >= 300 {
		return false, fmt.Errorf("push server answered %d", resp.StatusCode)
	}
	return false, nil
}
