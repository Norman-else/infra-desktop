// Fake aws-vault for manually testing Infra Desktop without real AWS keys.
// Supports:
//
//	list                                         - table like aws-vault list, with the cached session if any
//	clear PROFILE                                - drop the cached session
//	export --format=json [--mfa-token=CODE] PROFILE
//
// Without a cached session it needs a code; "000000" and any code used before are rejected (like STS).
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

var (
	sessionFile = filepath.Join(os.TempDir(), "fake-aws-vault-session")
	usedFile    = filepath.Join(os.TempDir(), "fake-aws-vault-used")
)

const mfaError = "aws-vault: error: exec: Failed to get credentials for root: operation error STS: AssumeRole, api error AccessDenied: MultiFactorAuthentication failed with invalid MFA one time pass code."

func sessionExpiry() (time.Time, bool) {
	b, err := os.ReadFile(sessionFile)
	if err != nil {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(string(b)))
	return t, err == nil && time.Now().Before(t)
}

func list() {
	fmt.Println("Profile                  Credentials              Sessions")
	fmt.Println("=======                  ===========              ========")
	sess := "-"
	if t, ok := sessionExpiry(); ok {
		d := time.Until(t).Round(time.Second)
		sess = fmt.Sprintf("sts.AssumeRole:%dh%dm%ds", int(d.Hours()), int(d.Minutes())%60, int(d.Seconds())%60)
	}
	fmt.Printf("%-25s%-25s%s\n", "root", "root", sess)
	for _, p := range []string{"dev", "sat", "prod"} {
		fmt.Printf("%-25s%-25s%s\n", p, "-", sess)
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "list" {
		list()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "clear" {
		os.Remove(sessionFile)
		return
	}
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
	ttl := 3600
	if v, err := strconv.Atoi(os.Getenv("FAKE_TTL_SECONDS")); err == nil {
		ttl = v
	}
	expiry, valid := sessionExpiry()
	if !valid {
		if token == "" {
			fmt.Fprintf(os.Stderr, "Enter MFA code for arn:aws:iam::000000000000:mfa/fake: ")
			line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
			token = strings.TrimSpace(line)
		}
		used, _ := os.ReadFile(usedFile)
		reused := token != "" && strings.Contains(string(used), token+"\n")
		os.WriteFile(usedFile, append(used, []byte(token+"\n")...), 0600)
		time.Sleep(1500 * time.Millisecond) // like a real STS round trip
		if token == "" || token == "000000" || reused {
			fmt.Fprintln(os.Stderr, mfaError)
			os.Exit(1)
		}
		expiry = time.Now().Add(time.Duration(ttl) * time.Second)
		os.WriteFile(sessionFile, []byte(expiry.Format(time.RFC3339)), 0600)
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{
		"Version": 1, "AccessKeyId": "ASIAFAKE" + strings.ToUpper(profile), "SecretAccessKey": "fakesecret",
		"SessionToken": "faketoken", "Expiration": expiry.UTC().Format(time.RFC3339), // cached credentials keep their original expiry
	})
}
