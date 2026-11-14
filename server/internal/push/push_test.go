package push

import (
	"net"
	"testing"
)

func TestBlockedAddresses(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "10.0.6.11", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1",
		"0.1.2.3", "198.18.0.1", "240.0.0.1", "255.255.255.255", "224.0.0.1",
		"::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
		"64:ff9b::a00:1", "2002:a00:1::1", "2001::1", "::",
	}
	for _, a := range blocked {
		if !isBlockedIP(net.ParseIP(a)) {
			t.Errorf("%s must be blocked", a)
		}
	}
	allowed := []string{"1.1.1.1", "91.64.57.158", "2a01:4f9:3a:3931::1", "2606:4700::1111"}
	for _, a := range allowed {
		if isBlockedIP(net.ParseIP(a)) {
			t.Errorf("%s must be allowed", a)
		}
	}
}
