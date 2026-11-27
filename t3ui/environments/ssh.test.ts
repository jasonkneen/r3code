import { expect, test } from "nsh/test";
import { activeSshTunnels, defaultSshCommand, parseSshHosts, SSH_KEY_ONLY_MESSAGE, startSshTunnel, stopAllSshTunnels, testSshConnection, type ProcessRunner } from "./ssh";

function fakeRunner(result: { code: number; stderr: string }) {
  const spawned: { args: string[]; killed: boolean; exit?: (r: { code: number }) => void; err?: (t: string) => void }[] = [];
  const runner: ProcessRunner = {
    run: async () => ({ code: result.code, stdout: "", stderr: result.stderr }),
    spawn: (_command, args) => {
      const child: (typeof spawned)[number] = { args, killed: false };
      spawned.push(child);
      return {
        on(event: string, handler: any) { if (event === "exit") child.exit = handler; if (event === "stderr") child.err = handler; return this; },
        kill() { child.killed = true; child.exit?.({ code: 0 }); },
      } as any;
    },
  };
  return { runner, spawned };
}

test("hosts come from ssh config aliases and known_hosts", () => {
  const hosts = parseSshHosts("Host box *.wild\n  HostName 10.0.0.2\nHost dev\n", "10.0.0.2 ssh-ed25519 AAA\n[other.example]:2222 ssh-rsa BBB\n|1|hashed ssh-rsa C\n");
  expect(hosts.map((host) => `${host.alias}:${host.hostname}:${host.port}`).join(",")).toBe("box:10.0.0.2:null,dev:dev:null,other.example:other.example:2222");
});

test("password hosts get the key-only message; a tunnel forwards and is torn down", async () => {
  const refused = fakeRunner({ code: 255, stderr: "user@box: Permission denied (publickey,password)." });
  await expect(testSshConnection(refused.runner, { alias: "box", hostname: "box", username: null, port: null })).rejects.toThrow(SSH_KEY_ONLY_MESSAGE);
  const ok = fakeRunner({ code: 0, stderr: "" });
  await testSshConnection(ok.runner, { alias: "box", hostname: "box", username: "me", port: 22 });
  await startSshTunnel(ok.runner, "box", { alias: "box", hostname: "box", username: null, port: null }, 41000, 3773);
  expect(ok.spawned[0]!.args.join(" ").includes("-N -L 41000:127.0.0.1:3773 -- box")).toBe(true);
  expect(ok.spawned[0]!.args.includes("BatchMode=yes")).toBe(true);
  expect(activeSshTunnels().join(",")).toBe("box");
  stopAllSshTunnels();
  expect(ok.spawned[0]!.killed).toBe(true);
  expect(activeSshTunnels().length).toBe(0);
});

test("defaultSshCommand resolves ssh.exe on Windows and /usr/bin/ssh elsewhere", () => {
  expect(defaultSshCommand("windows")).toBe("ssh.exe");
  expect(defaultSshCommand("macos")).toBe("/usr/bin/ssh");
  expect(defaultSshCommand("linux")).toBe("/usr/bin/ssh");
});
