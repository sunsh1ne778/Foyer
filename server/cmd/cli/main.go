package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"filestore/internal/cliclient"
)

var asJSON bool

func main() {
	root := &cobra.Command{Use: "filestore", Short: "File platform CLI"}
	root.PersistentFlags().BoolVar(&asJSON, "json", false, "JSON output")
	root.AddCommand(loginCmd(), lsCmd(), statCmd(), mkdirCmd(), rmCmd(), putCmd(), getCmd(), cpCmd(), mvCmd(), mountCmd(), jobCmd())
	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func client() *cliclient.Client {
	cfg, err := cliclient.LoadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "not logged in; run filestore login")
		os.Exit(1)
	}
	return cliclient.New(cfg, asJSON)
}

func printOut(v any) {
	if asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(v)
		return
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
}

func loginCmd() *cobra.Command {
	var server, user, pass string
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Login and store server+token in ~/.filestore/config",
		RunE: func(cmd *cobra.Command, args []string) error {
			if server == "" {
				server = "http://127.0.0.1:8090"
			}
			c := cliclient.New(cliclient.Config{Server: server}, asJSON)
			out, err := c.Login(user, pass)
			if err != nil {
				return err
			}
			tok, _ := out["token"].(string)
			if err := cliclient.SaveConfig(cliclient.Config{Server: server, Token: tok}); err != nil {
				return err
			}
			printOut(map[string]any{"ok": true, "server": server})
			return nil
		},
	}
	cmd.Flags().StringVar(&server, "server", "http://127.0.0.1:8090", "API base")
	cmd.Flags().StringVar(&user, "username", "admin", "username")
	cmd.Flags().StringVar(&pass, "password", "", "password")
	return cmd
}

func lsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "ls <mount:path>",
		Short: "List directory",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().List(args[0])
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	}
}

func statCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stat <mount:path>",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().Stat(args[0])
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	}
}

func mkdirCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "mkdir <mount:path>",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().Mkdir(args[0])
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	}
}

func rmCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rm <mount:path>",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return client().Remove(args[0])
		},
	}
}

func putCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "put <local> <mount:path>",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			dest := args[1]
			if !hasPath(dest) {
				dest = dest + "/" + filepath.Base(args[0])
			}
			return cliclient.PutFile(client(), args[0], dest)
		},
	}
}

func getCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <mount:path> <local>",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return cliclient.GetFile(client(), args[0], args[1])
		},
	}
}

func cpCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cp <src> <dst>",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().Copy(args[0], args[1], true)
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	}
}

func mvCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "mv <src> <dst>",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().Move(args[0], args[1], true)
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	}
}

func jobCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "job <id>",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().Job(args[0])
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	}
}

func mountCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "mount", Short: "Manage mounts"}
	cmd.AddCommand(&cobra.Command{
		Use: "ls",
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().ListMounts()
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	})
	var typ string
	spec := map[string]string{}
	add := &cobra.Command{
		Use:  "add <name>",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"name": args[0], "type": typ, "spec": spec}
			out, err := client().CreateMount(body)
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	}
	add.Flags().StringVar(&typ, "type", "local", "driver type")
	add.Flags().StringToStringVar(&spec, "spec", map[string]string{}, "spec key=value")
	cmd.AddCommand(add)
	cmd.AddCommand(&cobra.Command{
		Use:  "rm <id>",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return client().DeleteMount(args[0])
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:  "probe <id>",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().ProbeMount(args[0])
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:  "unmount <id>",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().Unmount(args[0])
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:  "mount <id>",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := client().Remount(args[0])
			if err != nil {
				return err
			}
			printOut(out)
			return nil
		},
	})
	return cmd
}

func hasPath(p string) bool {
	_, rest, ok := splitMount(p)
	return ok && rest != "" && rest != "/"
}

func splitMount(p string) (string, string, bool) {
	i := 0
	for i < len(p) && p[i] != ':' {
		i++
	}
	if i >= len(p) {
		return "", "", false
	}
	return p[:i], p[i+1:], true
}
