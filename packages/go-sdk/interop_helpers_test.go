package weldall

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// node runs a mode of testdata/interop.ts with the official TypeScript SDK and
// decodes its JSON output. The interop tests are skipped when pnpm or the
// workspace dependencies are missing, unless WELDALL_REQUIRE_INTEROP is set
// (CI sets it, so a missing toolchain fails instead of passing silently).
func node(t *testing.T, mode string, input any, output any) {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	_, pnpmErr := exec.LookPath("pnpm")
	_, modulesErr := os.Stat(filepath.Join(root, "packages/sdk/node_modules/jose"))
	if pnpmErr != nil || modulesErr != nil {
		if os.Getenv("WELDALL_REQUIRE_INTEROP") != "" {
			t.Fatalf("interop toolchain missing: pnpm=%v, node_modules=%v", pnpmErr, modulesErr)
		}
		t.Skip("pnpm workspace not installed; run pnpm install at the repository root")
	}
	cmd := exec.Command("pnpm", "--silent", "exec", "tsx", "packages/go-sdk/testdata/interop.ts", mode)
	cmd.Dir = root
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		cmd.Stdin = bytes.NewReader(data)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("interop %s: %v\n%s", mode, err, stderr.String())
	}
	if err := json.Unmarshal(stdout.Bytes(), output); err != nil {
		t.Fatalf("interop %s output: %v\n%s", mode, err, stdout.String())
	}
}
