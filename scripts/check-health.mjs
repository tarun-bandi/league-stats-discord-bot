const base = process.env.WORKER_URL;
if (!base || new URL(base).protocol !== "https:") throw new Error("Set WORKER_URL to an HTTPS Worker URL");
for (const path of ["/", "/monitor/status", "/commands"]) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Health request ${path} failed: HTTP ${response.status}`);
  if (path === "/" && !(await response.json()).ok) throw new Error("Worker is not healthy");
  if (path === "/monitor/status") {
    const status = await response.json();
    if (!status.configured || !status.stateValid || status.transport !== "bot") throw new Error("Monitor is not ready");
  }
  if (path === "/commands") {
    const commands = await response.json();
    if (!commands.find((command) => command.name === "recent")?.options?.some((option) => option.name === "mode")) throw new Error("Updated command schema is unavailable");
    const champion = commands.find((command) => command.name === "stats")?.options?.find((option) => option.name === "champion");
    if (champion?.type !== 3 || champion.required !== false || !champion.autocomplete) throw new Error("Champion stats option is unavailable");
  }
}
console.log("PASS: Worker, bot monitor configuration, D1 state and command schema are reachable.");
