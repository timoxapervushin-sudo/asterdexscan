import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["server.mjs"], { stdio: "inherit", shell: false, env: { ...process.env, PORT: "8788" } }),
  process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", "npx vite --host 127.0.0.1 --port 5178"], { stdio: "inherit", shell: false })
    : spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5178"], { stdio: "inherit", shell: false })
];

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) process.exitCode = code;
    shutdown();
  });
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
