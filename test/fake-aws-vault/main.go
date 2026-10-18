// Fake aws-vault for manually testing Radar Desktop without real AWS keys.
// Supports: export --format=json [--mfa-token=CODE] PROFILE
// First call without a cached session prompts for MFA on stderr; "000000" is rejected.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func main() {
	var token, profile string
	for _, a := range os.Args[1:] {
		switch {
		case strings.HasPrefix(a, "--mfa-token="):
			token = strings.TrimPrefix(a, "--mfa-token=")
		case strings.HasPrefix(a, "-"), a == "export":
		default:
			profile = a
		}
	}
	sessionFile := filepath.Join(os.TempDir(), "fake-aws-vault-session")
	ttl := 3600
	if v, err := strconv.Atoi(os.Getenv("FAKE_TTL_SECONDS")); err == nil {
		ttl = v
	}
	valid := false
	if b, err := os.ReadFile(sessionFile); err == nil {
		if t, err := time.Parse(time.RFC3339, strings.TrimSpace(string(b))); err == nil && time.Now().Before(t) {
			valid = true
		}
	}
	if !valid {
		if token == "" {
			fmt.Fprintf(os.Stderr, "Enter MFA code for arn:aws:iam::000000000000:mfa/fake: ")
			line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
			token = strings.TrimSpace(line)
		}
		if token == "" || token == "000000" {
			fmt.Fprintln(os.Stderr, "aws-vault: error: exec: Failed to get credentials for root: operation error STS: GetSessionToken, api error AccessDenied: MultiFactorAuthentication failed with invalid MFA one time pass code.")
			os.Exit(1)
		}
		os.WriteFile(sessionFile, []byte(time.Now().Add(time.Duration(ttl)*time.Second).Format(time.RFC3339)), 0600)
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{
		"Version": 1, "AccessKeyId": "ASIAFAKE" + strings.ToUpper(profile), "SecretAccessKey": "fakesecret",
		"SessionToken": "faketoken", "Expiration": time.Now().Add(time.Duration(ttl) * time.Second).UTC().Format(time.RFC3339),
	})
}
