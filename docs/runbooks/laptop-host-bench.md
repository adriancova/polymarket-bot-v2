# Laptop host bench (`HOST-BENCH`): a guide for a fresh agent

This guide measures the dedicated laptop before the first deployment runs on it
([`docs/handoffs/LEAN-1.md`](../handoffs/LEAN-1.md) §9, "What gets measured
first"). It is written for a Claude Code agent with no prior context, running
inside WSL Ubuntu on that laptop. The user starts it with one instruction:
"follow `docs/runbooks/laptop-host-bench.md`".

What you produce:
- `docs/bench/host-bench-laptop-<YYYY-MM-DD>.md`: the results, on a branch `host-bench-results-<YYYY-MM-DD>`, pushed. No pull request.
- `~/pmb-host-bench/`: every raw output. It is never committed.

What you measure:
1. The trader's throughput on the H1 burst fixture (Part 3).
2. A 24-hour recording of 8 public up/down markets (Part 4).
3. The host's CPU, memory, disk, network and thermals over those 24 hours (Part 5).

Time: about 1 hour of setup, about 3 hours of trader bench, 24 hours of
recording, and 1 hour for the results. The laptop does nothing else meanwhile.

The laptop: an ASUS TUF F15 (2023). i7-12700H (6 performance cores with two
threads each, 8 efficiency cores; 20 logical processors), 16 GB RAM, 1 TB SSD
with about 600 GB free, 1 Gb/s with no data cap, Windows 11 Home, WSL2 Ubuntu
24.04.

## How to use this guide

- Parts 1 to 6 are yours. Part 0 is the user's, done on Windows before you start. Check its results in step 2.2.
- Run every command in the WSL Ubuntu shell unless a step says "PowerShell". Commands are meant to be pasted as they are.
- Each command block starts with `. ~/pmb-host-bench/env.sh`. Your shell does not keep variables between commands; that file restores them.
- Anything that can run longer than 5 minutes runs inside `tmux`. You then poll its log. A detached `tmux` session survives the end of your turn.
- **STOP** means: stop, write what happened to `~/pmb-host-bench/PROGRESS.md`, tell the user, and wait.
- Keep `~/pmb-host-bench/PROGRESS.md` current. After each step, append one line: the step number, the UTC time and the outcome. If you are a new agent resuming, read that file first and continue from the first step not marked done.

## Part 0: operator steps (the user, on Windows, before starting the agent)

The agent cannot do these: they need Windows settings, an administrator, or a
password. Do them in order.

0.1. **Power.** Plug the charger in; it stays in for the whole bench. Open PowerShell **as administrator** and run:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
powercfg /hibernate off
```

These turn sleep and hibernation off on AC, and make closing the lid do nothing.
Then open Settings > System > Power & battery and set Power mode to **Best performance**.
In the ASUS software, if it is installed, choose the Performance or Turbo mode.
Keep the vents clear.

0.2. **Network.** Use Ethernet if you can. In Device Manager > Network adapters > your Ethernet adapter > Power Management, clear "Allow the computer to turn off this device to save power". If only Wi-Fi is possible, tell the agent in step 0.13.

0.3. **Windows Update.** Settings > Windows Update > "Pause updates" for 1 week, so no forced restart falls inside the 24 hours.

0.4. **WSL.** In the administrator PowerShell:

```powershell
wsl --install --no-distribution
```

Restart Windows if it asks.

0.5. **WSL limits.** In a normal PowerShell (not administrator):

```powershell
@"
[wsl2]
memory=11GB
processors=20
swap=4GB
"@ | Set-Content -Encoding ascii "$env:USERPROFILE\.wslconfig"
Get-Content "$env:USERPROFILE\.wslconfig"
```

This gives WSL 11 GB of the 16 GB and all 20 logical processors, and leaves about 5 GB for Windows.

0.6. **Ubuntu.** In PowerShell:

```powershell
wsl --update
wsl --install -d Ubuntu-24.04
```

Choose a Unix user name and password when Ubuntu asks. Then, optionally, make its virtual disk give freed space back to Windows:

```powershell
wsl --shutdown
wsl --manage Ubuntu-24.04 --set-sparse true
```

If WSL answers that sparse disks are disabled or unsafe, skip it. Do not add `--allow-unsafe`. The laptop has enough free space either way.

0.7. **Clone the repository.** Open the Ubuntu window and run, with the repository's URL:

```bash
git clone <REPOSITORY-URL> ~/polymarket-bot
```

0.8. **Copy the fixture.** Put `run-1-window-burst.jsonl.gz` in `~/pmb-fixtures/`. For example, if it is in your Windows Downloads folder:

```bash
mkdir -p ~/pmb-fixtures
cp "/mnt/c/Users/<your Windows user>/Downloads/run-1-window-burst.jsonl.gz" ~/pmb-fixtures/
ls -l ~/pmb-fixtures
```

0.9. **Root setup.** Still in Ubuntu (it asks for your Ubuntu password once):

```bash
cd ~/polymarket-bot
sudo bash tools/bench/host/setup-wsl-root.sh
```

It turns systemd on, installs the base packages and Docker Engine inside WSL (not Docker Desktop), and adds you to the `docker` group. Its last line says whether a restart is needed.

0.10. **Restart WSL.** Close the Ubuntu window. In PowerShell run `wsl --shutdown`, then open Ubuntu again and check:

```bash
ps -p 1 -o comm=
docker run --rm hello-world | head -3
```

The first line must print `systemd`, and the second "Hello from Docker!".

0.11. **GitHub and Git identity** (the agent pushes one results branch):

```bash
gh auth login
gh auth setup-git
git config --global user.name "<name to show on the commit>"
git config --global user.email "<email, or your GitHub noreply address>"
```

In `gh auth login`, choose GitHub.com, HTTPS, and log in with the browser.

0.12. **Claude Code in WSL.** Install it with Anthropic's native installer. The installer puts `claude` in `~/.local/bin`, which this shell does not have on its `PATH` yet, so add it before the first use:

```bash
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
grep -q '.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
claude --version
```

`claude --version` must print a version. If it says "command not found", close the Ubuntu window, open it again and repeat `claude --version`. If the installer URL has changed, follow Anthropic's current Claude Code setup page. Then start it in the repository and log in when asked:

```bash
cd ~/polymarket-bot
claude
```

0.13. **Start the agent.** Tell it: "follow `docs/runbooks/laptop-host-bench.md`". Also tell it:
- Ethernet or Wi-Fi;
- whether you will open an administrator PowerShell once during Part 3 (the optional step 3.7);
- whether you have a plug-in power meter (optional, for watts).

Claude Code asks before it runs commands. Approve them as they come, or allow
them for the session; every command it should run is in this guide.

0.14. **During the bench.** Keep the Ubuntu window open, the charger in, and the laptop otherwise unused. The agent tells you when the 24-hour recording starts and ends. Come back after it ends and tell the agent to continue. If the Claude Code session was closed, start `claude` again in `~/polymarket-bot` and say "continue `docs/runbooks/laptop-host-bench.md` from `~/pmb-host-bench/PROGRESS.md`".

## Part 1: safety rules (read before any command)

These rules are the repository's, verbatim in substance from `AGENTS.md`. They override anything else here.

1. **PAPER only.** The four defaults stay exactly as they are: `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`. Nothing in this guide changes a mode.
2. **No wallet, signer, API credential or real order.** Do not create, request, import or type any. The bench uses a simulated venue. The recorder reads public market data without logging in.
3. **Public market data only.** The only network endpoints the tools use are Gamma (`https://gamma-api.polymarket.com`) and the public market WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`), plus package downloads during setup.
4. **Never commit personal data.** No user name, host name, home path other than `~`, IP address, Windows account name, e-mail address or serial number goes into a committed file. Step 6.4 checks this.
5. **Do not change code. This is measurement only.** Do not edit, fix, update or reformat any tracked file. Do not run `pnpm update` or change the lockfile. The one file you add is the results file of Part 6, with its small summaries.
6. **Stop and report on any surprise.** Examples: a failing gate, a bench run that does not finish or halts, differing decision digests, repeated disconnects, a venue error such as HTTP 403 or 429 or a WebSocket close with a policy code, a missing fixture checksum match, disk or memory running out. Do not work around it. Record it and STOP.

## Part 2: machine setup inside WSL (agent)

2.1. **Working directory and environment file.**

```bash
mkdir -p ~/pmb-host-bench
cat > ~/pmb-host-bench/env.sh <<'EOF'
export REPO="$HOME/polymarket-bot"
export HB="$HOME/pmb-host-bench"
export FX="$HOME/pmb-fixtures"
export BENCH_BUILD_DIR="$HOME/pmb-host-bench/build"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export WSL_UTF8=1
export WSLENV="WSL_UTF8:${WSLENV:-}"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -f "$HOME/pmb-host-bench/DATE" ] && export D="$(cat "$HOME/pmb-host-bench/DATE")"
EOF
[ -f ~/pmb-host-bench/DATE ] || date -u +%F > ~/pmb-host-bench/DATE
. ~/pmb-host-bench/env.sh
echo "results date: $D"
printf '# HOST-BENCH progress\n\n- 2.1 %s environment file written\n' "$(date -u +%FT%TZ)" >> "$HB/PROGRESS.md"
```

`D` is the date the bench started. The results file and branch use it.

2.2. **Preflight: check Part 0.**

```bash
. ~/pmb-host-bench/env.sh
grep -qi microsoft /proc/version && echo "WSL: ok"
ps -p 1 -o comm=
docker info --format 'docker {{.ServerVersion}} on {{.OperatingSystem}}'
python3 --version
tmux -V; zstd --version | head -1; iostat -V | head -1; gh --version | head -1
nproc; free -g | head -2; df -h / | tail -1
ls -l "$FX/run-1-window-burst.jsonl.gz"
git -C "$REPO" status --short | head; git -C "$REPO" log --oneline -1
gh auth status 2>&1 | head -3
```

Expected:
- `WSL: ok`, `systemd`, and a Docker version on `Ubuntu 24.04...`. If it says Docker Desktop, STOP: the user must run 0.9 and 0.10.
- Python 3.12, and a version line for tmux, zstd, iostat and gh.
- `nproc` 20; `free -g` total about 10-11; more than 400 GB available on `/`.
- The fixture file; an empty `git status`; `gh` logged in.

If `docker` answers "permission denied", the group change is not active. Ask the user to run step 0.10 again, then STOP until they have. If any other check fails, STOP and name the Part 0 step it belongs to.

2.3. **Node 24 and pnpm 11.** The repository's `engines` require Node 24 or later and pnpm 11 or later, and `package.json` pins `pnpm@11.17.0`. nvm installs Node without root:

```bash
curl -fsSL -o /tmp/nvm-install.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh
bash /tmp/nvm-install.sh
. ~/pmb-host-bench/env.sh
nvm install 24
nvm alias default 24
corepack enable
cd "$REPO" && corepack install
node --version; pnpm --version
```

Expected: `v24.` something, and `11.17.0`.

2.4. **Install and smoke gate.** This proves the toolchain; it changes nothing. The install and typecheck take a few minutes; the unit suite can take 10 or more, so it runs in `tmux`.

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
pnpm install --frozen-lockfile 2>&1 | tail -5
git status --short
( time pnpm run typecheck ) > "$HB/gate-typecheck.log" 2>&1; echo "typecheck exit=$?"; tail -4 "$HB/gate-typecheck.log"
tmux new-session -d -s pmb-gate "bash -c '. ~/pmb-host-bench/env.sh; cd \"\$REPO\"; ( time pnpm run test ) > \"\$HB/gate-test.log\" 2>&1; echo \"exit=\$?\" >> \"\$HB/gate-test.log\"'"
```

Poll until `gate-test.log` ends with an `exit=` line:

```bash
. ~/pmb-host-bench/env.sh
tail -12 "$HB/gate-test.log"
```

Expected: `git status` prints nothing, typecheck `exit=0`, and the test log ends with `Test Files ... passed`, the `time` lines and `exit=0`. Record the test count and the wall time.

Any failure: STOP. Do not rerun the suite to make it pass. Before you stop, collect the evidence the user needs:
- the failing file and test names, and whether the failure reads `Test timed out in 5000ms` (a load-sensitive timeout) or is an assertion;
- one isolated diagnostic run of each failing file, for example `pnpm exec vitest run <failing file> 2>&1 | tail -15`, and its result.

Write both to `PROGRESS.md` and report them together. A file that passes alone does not turn the failure into a pass; the user decides whether to go on.

2.5. **The recorder's Python environment.**

```bash
. ~/pmb-host-bench/env.sh
python3 -m venv "$HB/venv"
"$HB/venv/bin/pip" install -q -r "$REPO/tools/bench/host/requirements.txt"
"$HB/venv/bin/python" -m unittest discover -s "$REPO/tools/bench/host/tests" 2>&1 | tail -3
```

Expected: `Ran 69 tests` (or more) and `OK`. These are offline: no network, no container.

2.6. **The fixture.** Verify the checksum, then decompress it next to the original:

```bash
. ~/pmb-host-bench/env.sh
cd "$FX"
echo "fd3b81469c27603b6d79de59a4637d5c62684d4d9e9cf22b6499d4052086db36  run-1-window-burst.jsonl.gz" | sha256sum -c -
gunzip -kf run-1-window-burst.jsonl.gz
wc -l run-1-window-burst.jsonl
```

Expected: `run-1-window-burst.jsonl.gz: OK` and `100000 run-1-window-burst.jsonl`. A checksum mismatch: STOP.

This is H1 run 1's last 100,000 stream envelopes. The bench replays it from index 332, the first point where every level change has a baseline, plus the `MarketOpened` envelope. So every full run consumes **99,669** events ([`tools/bench/trader-throughput/README.md`](../../tools/bench/trader-throughput/README.md), "The fixture"). The other two inputs are committed: `test/fixtures/trader-throughput/market-opened.json` and `template.json`.

2.7. **Machine facts.** These go to a local file; the results file later takes only the fields step 6.1 lists.

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
{
  echo "## date"; date -u +%FT%TZ
  echo "## code"; git -C "$REPO" rev-parse HEAD
  echo "## wsl"; wsl.exe --version 2>/dev/null | tr -d '\r'
  echo "## kernel"; uname -r
  echo "## os"; . /etc/os-release; echo "$PRETTY_NAME"
  echo "## cpu (inside WSL)"; lscpu | grep -E '^(Model name|CPU\(s\)|Thread|Core|Socket)'
  echo "## memory"; free -m | head -2
  echo "## disk"; df -h / | tail -1
  echo "## tools"; node --version; pnpm --version; python3 --version; docker version --format 'docker {{.Server.Version}}'
  echo "## windows cpu"; powershell.exe -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | Format-List" | tr -d '\r'
  echo "## windows model"; powershell.exe -NoProfile -Command "Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory | Format-List" | tr -d '\r'
  echo "## windows version"; powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).Version" | tr -d '\r'
  echo "## power plan"; powercfg.exe /getactivescheme | tr -d '\r'; echo
  echo "## power mode overlay on AC (a GUID; empty when Windows does not expose it)"; powershell.exe -NoProfile -Command "(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes').ActiveOverlayAcPowerScheme" | tr -d '\r'
  echo "## .wslconfig"; cat "$(wslpath "$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')")/.wslconfig"
} > "$HB/machine.txt" 2>&1
cat "$HB/machine.txt"
```

Also check the clock against a public server; the difference should be under 2 s:

```bash
date -u +'local %H:%M:%S'; curl -sI https://gamma-api.polymarket.com/ | grep -i '^date:'
```

If it is off by more than 2 s, see Troubleshooting, "Clock drift", before Part 3.

## Part 3: the trader throughput bench

What it is: [`tools/bench/trader-throughput/`](../../tools/bench/trader-throughput/README.md)
replays the burst through real Redis into the real durable PAPER trader on real
PostgreSQL. Each run starts its own `redis:7.4.2-alpine` and
`postgres:17.5-alpine` containers on 127.0.0.1 and removes them afterwards.
These are the same images and settings as every desktop number.
[`tools/bench/host/trader-bench.sh`](../../tools/bench/host/trader-bench.sh)
wraps it with this guide's fixed inputs.

- **catch-up** publishes everything first, then the trader drains it. It measures the ceiling: events/s.
- **paced** publishes each frame at its recorded spacing (about 136 s of market time). It measures whether the trader keeps up: the lag.

What to record per run: events/s, CPU µs per event, max and p99 lag, halts.
`bench_table.py` collects them.

The bench has no switch that turns the strategy's evaluation off, so LEAN-1
§9 item 1's "with and without evaluation" is NOT measured here: every run is
"with". Do not change code to add one. The results file lists it as
UNVERIFIED (step 6.1, section 5).

**About the cores.** The i7-12700H has 6 P-cores, each with 2 threads, and 8
E-cores with 1 thread each: 20 logical processors. P-cores run at up to about
4.7 GHz and E-cores at up to about 3.5 GHz. Windows usually numbers the P-core
threads first (0-11) and the E-cores last (12-19); step 3.6 checks this from
measurements.

WSL2 is a virtual machine. Windows, not Linux, decides which physical core
runs each of its 20 virtual CPUs at any moment. So `taskset` inside WSL pins a
process to a virtual CPU, **not** to a P-core. Which physical core runs that
virtual CPU is Windows' choice.

What `trader-bench.sh --pin 2` pins, exactly:
- the bench process, which runs the trader, to virtual CPU 2, so the trader never migrates between virtual CPUs inside the VM;
- in paced mode, the bench spawns a separate publisher process. The script moves it to every OTHER virtual CPU as soon as it appears, so the publisher never shares the trader's virtual CPU, just as in the unpinned runs. `runs.txt` records it as `publisher=<list>`;
- PostgreSQL and Redis, which Docker starts, are never pinned.

So the pinned runs differ from the unpinned ones in one thing only: the trader
stays on one virtual CPU.

Windows' own view per logical processor comes from the sampler
(`--windows-per-cpu`). The optional step 3.7 tries to restrict the WSL VM to
the P-cores from Windows.

The trader's work runs on one thread, so one core's speed decides its throughput.
PostgreSQL and Redis run in their own processes.

3.1. **Quiet host.** Close every other program on Windows. Then check nothing else is running in WSL:

```bash
. ~/pmb-host-bench/env.sh
docker ps --format '{{.Names}}' | wc -l
uptime
```

Expected: `0` containers and a load average under 1. Otherwise find out why before going on.

3.2. **Host sampler for Part 3** (every 30 s, with Windows' per-logical-processor view):

```bash
. ~/pmb-host-bench/env.sh
tmux new-session -d -s pmb-host3 "python3 $REPO/tools/bench/host/host_sampler.py sample --out-dir $HB/host-part3 --interval 30 --duration-hours 5 --path / --path-label wsl-root --windows --windows-per-cpu"
```

3.3. **The runs.** One script runs them all, in `tmux`:
- a warm-up that pulls the images and builds the bundles, which the results leave out;
- catch-up and paced alternately, 3 each, unpinned;
- one CPU-profiled catch-up;
- catch-up and paced alternately, 3 each, pinned to virtual CPU 2.

```bash
. ~/pmb-host-bench/env.sh
cat > "$HB/part3.sh" <<'EOF'
. "$HOME/pmb-host-bench/env.sh"
cd "$REPO"
T=tools/bench/host/trader-bench.sh
$T warmup catch-up --limit 5000 || exit 1
for i in 1 2 3; do
  $T "catch-up-$i" catch-up || exit 1
  $T "paced-$i" paced || exit 1
done
$T catch-up-profiled catch-up --cpu-prof || exit 1
for i in 1 2 3; do
  $T --pin 2 "pinned-catch-up-$i" catch-up || exit 1
  $T --pin 2 "pinned-paced-$i" paced || exit 1
done
echo "PART3-DONE $(date -u +%FT%TZ)" >> "$HB/trader-throughput/runs.txt"
EOF
tmux new-session -d -s pmb-part3 "bash $HB/part3.sh > $HB/part3.log 2>&1"
```

Poll every few minutes until `PART3-DONE` appears (about 1-2 hours):

```bash
. ~/pmb-host-bench/env.sh
cat "$HB/trader-throughput/runs.txt"; tail -3 "$HB/part3.log"
```

Every line must say `exit=0`. A non-zero exit, or `halts:` other than `none`: STOP and keep the run's log (`$HB/trader-throughput/<label>.log`). Every `pinned-paced-*` line must also say `publisher=` followed by a list of CPUs. `publisher=missed` means the publisher ran on the trader's CPU, so that run does not compare with the unpinned ones: record it and STOP.

3.4. **The table and the determinism check.**

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
python3 tools/bench/host/bench_table.py "$HB/trader-throughput" | tee "$HB/trader-throughput-table.md"
python3 tools/bench/host/bench_table.py "$HB/trader-throughput" --json > "$HB/trader-throughput-rows.json"
python3 - <<'EOF'
import json, os
rows = json.load(open(os.path.expandvars("$HB/trader-throughput-rows.json")))
full = [r for r in rows if r["label"] != "warmup"]
print("consumed:", sorted({r["consumed"] for r in full}), "stopped:", sorted({r["stopped"] for r in full}), "halts:", sum(r["halts"] for r in full))
print("normalized decision digests:", sorted({r["normalizedDecisionSha256"] for r in full}))
EOF
```

Expected: consumed `[99669]`, stopped `['COMPLETE']`, halts `0`, and ONE normalized decision digest. Every run replays the same events through the same code, so their durable decisions must be identical in content. More than one digest: STOP. It is a determinism surprise.

3.5. **The CPU profile's top functions.**

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
prof="$(ls "$HB"/trader-throughput/catch-up-profiled/*/*.cpuprofile | head -1)"
tools/bench/trader-throughput/run.sh profile "$prof" --top 40 > "$HB/profile-top.txt"
head -60 "$HB/profile-top.txt"
```

3.6. **Which cores did the work?** Stop the Part 3 sampler and summarize it:

```bash
. ~/pmb-host-bench/env.sh
tmux send-keys -t pmb-host3 C-c; sleep 2
python3 "$REPO/tools/bench/host/host_sampler.py" summarize "$HB/host-part3/host-samples.jsonl" > "$HB/host-part3-summary.json"
python3 "$REPO/tools/bench/host/report_tables.py" host "$HB/host-part3-summary.json" | tail -25
```

Read the per-logical-processor table at the end. `performance % max` shows each processor's peak speed relative to the nominal frequency. P-core threads should reach clearly higher values than E-cores; about 4.7 against 3.5 GHz on this CPU. Record:
- whether processors 0-11 peak higher than 12-19, which confirms the numbering;
- which processors were busiest during the bench.

3.7. **Optional: the WSL VM on the P-cores only.** Do this only if the user agreed in step 0.13. Windows lets only an administrator change the VM's processor affinity. Ask the user to run this in an **administrator** PowerShell:

```powershell
$p = Get-Process -Name vmmemWSL
"before: " + $p.ProcessorAffinity
$p.ProcessorAffinity = 0xFFF
"after: " + (Get-Process -Name vmmemWSL).ProcessorAffinity
```

`0xFFF` selects logical processors 0-11, the P-core threads if step 3.6 confirmed the numbering. Record both printed values, or the error. Then run:

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
tmux new-session -d -s pmb-host-pcore "python3 $REPO/tools/bench/host/host_sampler.py sample --out-dir $HB/host-pcore --interval 30 --duration-hours 2 --path / --path-label wsl-root --windows --windows-per-cpu"
tmux new-session -d -s pmb-pcore "bash -c '. ~/pmb-host-bench/env.sh; cd \"\$REPO\"; for i in 1 2 3; do tools/bench/host/trader-bench.sh pcore-catch-up-\$i catch-up || break; tools/bench/host/trader-bench.sh pcore-paced-\$i paced || break; done; echo PCORE-DONE >> \"\$HB/trader-throughput/runs.txt\"'"
```

When `PCORE-DONE` appears, ask the user to restore the affinity in the same administrator PowerShell. `0xFFFFF` is all 20 logical processors:

```powershell
(Get-Process -Name vmmemWSL).ProcessorAffinity = 0xFFFFF
```

Then stop that sampler and look at where the work ran:

```bash
. ~/pmb-host-bench/env.sh
tmux send-keys -t pmb-host-pcore C-c; sleep 2
python3 "$REPO/tools/bench/host/host_sampler.py" summarize "$HB/host-pcore/host-samples.jsonl" > "$HB/host-pcore-summary.json"
python3 "$REPO/tools/bench/host/report_tables.py" host "$HB/host-pcore-summary.json" | tail -22
```

Caveats to write in the results:
- Nothing in this repository documents whether the `vmmemWSL` process's affinity binds the VM's virtual CPUs. The evidence is the per-logical-processor table above (did processors 12-19 stay idle?) and the µs per event against the unpinned runs.
- If Windows refuses the change, record "not feasible" and go on.
- A `wsl --shutdown` also resets it.

3.8. **Sustained load (1 hour).** A laptop's turbo and thermals can sag under long load. LEAN-1 §9 asks for the bench "over several hours". This runs catch-up back to back for an hour, with the sampler at 30 s:

```bash
. ~/pmb-host-bench/env.sh
tmux new-session -d -s pmb-host-sus "python3 $REPO/tools/bench/host/host_sampler.py sample --out-dir $HB/host-sustained --interval 30 --duration-seconds 4200 --path / --path-label wsl-root --windows"
cat > "$HB/sustained.sh" <<'EOF'
. "$HOME/pmb-host-bench/env.sh"
cd "$REPO"
end=$(( $(date +%s) + 3600 ))
i=1
while [ "$(date +%s)" -lt "$end" ]; do
  tools/bench/host/trader-bench.sh "sustained-$(printf %02d "$i")" catch-up || exit 1
  i=$((i + 1))
done
echo "SUSTAINED-DONE $(date -u +%FT%TZ)" >> "$HB/trader-throughput/runs.txt"
EOF
tmux new-session -d -s pmb-sustained "bash $HB/sustained.sh > $HB/sustained.log 2>&1"
```

When `SUSTAINED-DONE` appears, rerun step 3.4, which covers all runs including these. Then:

```bash
. ~/pmb-host-bench/env.sh
python3 - <<'EOF'
import json, os, statistics
rows = [r for r in json.load(open(os.path.expandvars("$HB/trader-throughput-rows.json"))) if r["label"].startswith("sustained-")]
first, last = rows[:3], rows[-3:]
m = lambda rs, k: statistics.median(r[k] for r in rs)
print(f"sustained runs: {len(rows)}")
print(f"first 3: {m(first, 'eventsPerSecond'):.1f} events/s, {m(first, 'cpuMicrosPerEvent')} us/event")
print(f"last 3:  {m(last, 'eventsPerSecond'):.1f} events/s, {m(last, 'cpuMicrosPerEvent')} us/event")
EOF
python3 "$REPO/tools/bench/host/host_sampler.py" summarize "$HB/host-sustained/host-samples.jsonl" > "$HB/host-sustained-summary.json"
python3 "$REPO/tools/bench/host/report_tables.py" host "$HB/host-sustained-summary.json" | grep -E 'performance|frequency|thermal|busy'
```

A drop of more than 10% from the first three to the last three is a throttling sign. Pair it with the Windows performance % and thermal readings.

3.9. **For context only: the development desktop.** On a Ryzen 9 7900, at `THROUGHPUT-2`'s merge `7d59fd3`:
- catch-up: 764-824 events/s, about 1,300 µs per event;
- paced: max lag 9.3-38.4 s, median 19.4 s ([`docs/handoffs/THROUGHPUT-2.md`](../handoffs/THROUGHPUT-2.md)).

The laptop is not graded against these numbers. If your commit is not `7d59fd3`, the code differs, and the orchestrator reruns the desktop at your commit. Write your commit in the results.

## Part 4: the 24-hour multi-market recording

What it is: [`tools/bench/host/record_markets.py`](../../tools/bench/host/record_markets.py)
records public market data only (see its [README](../../tools/bench/host/README.md)):
- **Discovery:** Gamma, once a minute.
- **Markets:** BTC, ETH, SOL and XRP, 5-minute and 15-minute up/down: 8 series.
- **Connections:** one public market WebSocket per series.
- **Windows:** the current window and the next one, rolled as each opens.

It counts bytes, frames, events and estimated envelopes per market per second,
and keeps the raw frames gzip-compressed. It does not run the gateway or the
trader. It does not record the Binance, Coinbase or Chainlink reference feeds.

4.1. **Preconditions.**

```bash
. ~/pmb-host-bench/env.sh
tmux ls 2>/dev/null; docker ps --format '{{.Names}}' | wc -l; df -h / | tail -1
```

Expected: no `pmb-part3`, `pmb-pcore` or `pmb-sustained` session still running; 0 containers; at least 150 GB available. The raw frames take roughly 10-25 GB a day compressed.

4.2. **Confirm the series.** The series names are values Gamma lists, not documented constants. Check that all 8 exist today:

```bash
. ~/pmb-host-bench/env.sh
"$HB/venv/bin/python" "$REPO/tools/bench/host/record_markets.py" --list-series | tee "$HB/series-listed.json"
```

Expected: each of `btc-up-or-down-5m`, `btc-up-or-down-15m`, `eth-up-or-down-5m`, `eth-up-or-down-15m`, `sol-up-or-down-5m`, `sol-up-or-down-15m`, `xrp-up-or-down-5m`, `xrp-up-or-down-15m` with a count above 0. If one is missing, record it and add `--series` with the ones present to the command in 4.3. If all are missing, STOP.

4.3. **Start the recorder and the sampler.**

```bash
. ~/pmb-host-bench/env.sh
tmux new-session -d -s pmb-rec "$HB/venv/bin/python $REPO/tools/bench/host/record_markets.py --out-dir $HB/recording --duration-hours 24 --raw 2> $HB/recording.stderr"
tmux new-session -d -s pmb-host24 "python3 $REPO/tools/bench/host/host_sampler.py sample --out-dir $HB/host-24h --interval 60 --duration-hours 24.25 --path / --path-label wsl-root --windows --windows-per-cpu --raw-commands"
date -u -d '+24 hours' +'recording ends at about %FT%TZ' | tee -a "$HB/PROGRESS.md"
```

4.4. **Check it after 6 minutes.**

```bash
. ~/pmb-host-bench/env.sh
grep -c ': connected;' "$HB/recording/recorder.log"; grep -c ': disconnected' "$HB/recording/recorder.log"
grep -E 'FAILED|TRUNCATED' "$HB/recording/recorder.log" || echo "no failure lines"
python3 "$REPO/tools/bench/host/report_tables.py" recording "$HB/recording/summary.partial.json"
tail -1 "$HB/host-24h/host-samples.jsonl" | head -c 300; echo
```

Expected:
- `8` connections and `0` disconnections; `no failure lines`;
- the first line of the tables says `outcome=running; failures=0`;
- a series table with non-zero GB/day for every series;
- `disconnects` 0 in the connection table;
- in the Gamma line, `last OK` under 180 s before the summary, and `truncated polls 0`;
- a sampler line.

If a series shows 0 bytes, the log repeats `disconnected`, or any line says `FAILED`, STOP. Check again after about 1 hour.

The recorder stops by itself, with exit status 3 and `"outcome": "failed"`, if any of its tasks dies. A failed Gamma poll is not a task death: it is counted (`failures`, by kind), and the next poll a minute later tries again. Market windows already known keep being recorded for up to 40 minutes meanwhile.

4.5. **Tell the user** the end time, that the Ubuntu window must stay open, and that they should come back and say "continue" after it. Write the step to `PROGRESS.md`. You may end your turn here.

4.6. **After 24 hours.** Confirm both finished:

```bash
. ~/pmb-host-bench/env.sh
tail -3 "$HB/recording/recorder.log"; ls -l "$HB/recording/summary.json"
python3 -c "import json,os; s = json.load(open(os.path.expandvars('\$HB/recording/summary.json'))); g = s['gamma']; print('final:', s['final'], 'outcome:', s['outcome'], 'failures:', s['failures']); print('gamma failures:', g['failures'], g['failureKinds'], 'most in a row:', g['maxConsecutiveFailures'], 'truncated:', g['truncatedPolls'])"
tmux ls 2>/dev/null
```

Expected: `wrote summary.json; outcome complete`, `final: True outcome: complete failures: []`, and no `pmb-rec` session. Gamma failures should be a handful at most; `most in a row` above 30 means discovery was down for over half an hour, which you record as an incident. If the sampler is still running, stop it with `tmux send-keys -t pmb-host24 C-c`.

`outcome: failed`: the recording stopped early. Its `failures` list says which task died and why. Record it verbatim, then STOP. Do not restart the recorder yourself.

If the recording stopped early, record the reason:
- The laptop slept, restarted or lost WSL: the sampler shows gaps. Keep what was recorded. `summary.partial.json` holds up to the last 5 minutes.
- If less than 20 hours were recorded, tell the user and ask whether to repeat Part 4.

4.7. **Tables and compression.**

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
python3 tools/bench/host/report_tables.py recording "$HB/recording/summary.json" | tee "$HB/recording-tables.md"
ratio() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", a / b }'; }
for s in btc-up-or-down-15m eth-up-or-down-5m; do
  f="$(ls "$HB/recording/raw/$s/"*.jsonl.gz | sed -n 12p)"
  [ -n "$f" ] || { echo "$s: fewer than 12 hourly files"; continue; }
  raw=$(zcat "$f" | wc -c); gz=$(stat -c %s "$f")
  z3=$(zcat "$f" | zstd -3 -c | wc -c); z19=$(zcat "$f" | zstd -19 -T0 -c | wc -c)
  echo "$s $(basename "$f"): raw $raw B; gzip-6 $gz B ($(ratio "$raw" "$gz")x); zstd-3 $z3 B ($(ratio "$raw" "$z3")x); zstd-19 $z19 B ($(ratio "$raw" "$z19")x)"
done | tee "$HB/compression.txt"
```

The ratios are on the JSONL lines that wrap each frame with its receive time. That is close to, but not the same as, the gateway's WAL segments. Say so in the results.

## Part 5: the host profile over the 24 hours

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
python3 tools/bench/host/host_sampler.py summarize "$HB/host-24h/host-samples.jsonl" > "$HB/host-24h-summary.json"
python3 tools/bench/host/report_tables.py host "$HB/host-24h-summary.json" | tee "$HB/host-24h-tables.md"
```

Read and record:
- **CPU:** WSL busy % (mean, p95, max) and iowait. The recorder's own CPU is the row `CPU % of one vCPU, python:record_markets.py` (100 means one whole virtual CPU). It should stay well under 100. The sampler itself is `python:host_sampler.py`.
- **Memory:** WSL `MemTotal` is the `.wslconfig` limit, about 11 GB. Record `MemAvailable` min, swap used max and memory pressure. Also the `vmmemWSL` working set max against the laptop's 16 GB, and Windows' free physical memory min.
- **Disk:** bytes written, write rate and utilization; free GiB at start and end.
- **Network:** WSL `eth0` received bytes over the 24 h against the recorder's text bytes (`all` bytes in the recording table), and the Windows adapters' received bytes. The difference is TLS, WebSocket and TCP/IP overhead plus anything else on the machine. The summary names the Windows adapters `adapter-1`, `adapter-2`, ... on purpose, because an adapter's name can be personal. To say which one is the Ethernet or Wi-Fi, look at the names in `host-samples.jsonl` on the laptop and describe the adapter by type only ("adapter-2, the Ethernet").
- **Throttling signs:** Windows % processor performance well under 100 while busy; `thermal passive limit %` under 100; thermal max. Also any sampler gaps, which are suspends or restarts.
- **Power:** battery status counts. 2 means on AC; any other value means the laptop ran on battery.
- **Watts,** if the user has a plug meter: ask them for readings at idle, during Part 3 and during Part 4.

## Part 6: results

6.1. **Write the results file** `docs/bench/host-bench-laptop-$D.md` in the repository. Use this skeleton and fill every section from your files in `~/pmb-host-bench/`. Follow [`docs/handoffs/README.md`](../handoffs/README.md): short sentences, exact numbers, tables.

```markdown
# Laptop host bench, <D>

- Guide: docs/runbooks/laptop-host-bench.md. Code: <full commit SHA of the repository HEAD>.
- Host: ASUS TUF F15 (2023), <Windows CPU name>, <logical processors>, <RAM>; Windows <caption and version>; WSL <version>; Ubuntu <version>; kernel <version>.
- Settings: power mode <Best performance, as the operator confirmed; overlay GUID from machine.txt>; network <Ethernet or Wi-Fi>; .wslconfig memory=11GB processors=20 swap=4GB; sparse disk <yes/no>.
- Toolchain: Node <v>, pnpm <v>, Python <v>, Docker <v>. Smoke gate: typecheck exit 0 in <t>; unit tests <N files / N tests> passed in <t>.
- Safety: PAPER only; no credential; public market data only.

## Summary
<5-8 bullets: catch-up events/s and µs/event; paced max lag; pinned vs unpinned; sustained drift; total and per-series GB/day; peak rates at aligned opens; baseline capacity; any surprise.>
<Baseline capacity, stated as such: the trader's throughput measured ALONE (Part 3) and the recorder's and host's load measured ALONE (Parts 4 and 5). They ran at different times. The headroom of a deployment, with the gateway, the trader and the recording all running at once, was NOT measured; do not add the two up and call it headroom.>

## 1. Trader throughput (H1 burst, 99,669 events)
<the table from trader-throughput-table.md, without the warm-up row>
<the profile's top 15 by self time, from profile-top.txt: percentage, milliseconds and function name only; drop the file paths, which name the home directory>
<cores: step 3.6 findings; pinned vs unpinned; step 3.7 result or "not run">
<sustained: first 3 vs last 3, with the Windows performance % and thermal readings>
<desktop context (step 3.9), stating whether the commits match>

## 2. 24-hour recording
<recording-tables.md>
<compression.txt, with the note from step 4.7>

## 3. Host profile
<host-24h-tables.md; memory, disk, network and throttling findings from Part 5>

## 4. Incidents and surprises
<every gap, disconnect, retry, STOP and how it was resolved; "none" if none>

## 5. Not measured here
UNVERIFIED items of LEAN-1 §9, each with its follow-up for the orchestrator:
- Item 1, "with and without evaluation": UNVERIFIED. The bench has no switch for it; every run here is "with". Follow-up: a bench option, in a code round, then a rerun.
- Item 2, "gateway only, through the existing restart driver": this recording used the standalone recorder (`tools/bench/host/record_markets.py`) instead. The byte and rate figures are the venue's market-channel traffic; the gateway's own CPU, memory and WAL bytes are UNVERIFIED. Follow-up: a gateway recording on the laptop.
- Item 3, SNAPPY Parquet compression: UNVERIFIED. Only gzip and zstd on the recorder's JSONL were measured (step 4.7). Follow-up: a Parquet conversion of the same hours.
- Item 6, "Redis bytes per entry": UNVERIFIED. The bench removes its Redis container after each run, and this guide takes no Redis memory reading. Follow-up: a measurement against a kept bench Redis.
- Deployment headroom (the gateway, trader and recording at once): UNVERIFIED; only the baseline capacity of each part alone was measured.
- The Binance, Coinbase and Chainlink reference feeds (LEAN-1 §4 measured them on H1 at about 6 GB/day per asset).
- The Hetzner comparison, research-tier sizes, state churn and restart behaviour (LEAN-1 §9 items 1 (cloud half), 4, 5 and 7).
- <anything else skipped, such as watts or thermal zones Windows did not expose>

## 6. Commands
<the commands as run, from this guide, with any changes; home paths written as ~>

## 7. Raw outputs on the laptop (not committed)
~/pmb-host-bench/: machine.txt, gate-*.log, trader-throughput/, profile-top.txt, host-part3/, host-sustained/, recording/, host-24h/, compression.txt.
```

6.2. **Small raw summaries.** Put them in `docs/bench/host-bench-laptop-$D/`, never more than about 1 MB in total:

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
mkdir -p "docs/bench/host-bench-laptop-$D"
python3 tools/bench/host/report_tables.py trim "$HB/recording/summary.json" > "docs/bench/host-bench-laptop-$D/recording-summary.json"
cp "$HB/host-24h-summary.json" "docs/bench/host-bench-laptop-$D/host-24h-summary.json"
cp "$HB/trader-throughput-rows.json" "docs/bench/host-bench-laptop-$D/trader-throughput-rows.json"
du -sh "docs/bench/host-bench-laptop-$D"
```

6.3. **What never goes in:** `machine.txt` as a whole, any `*.log`, `host-raw.log`, raw frames, `per-second.jsonl.gz`, `docker info` output (it prints the host name), and anything under `~/pmb-host-bench/` beyond the three files above.

6.4. **Redaction check.** Run it on everything you are about to commit:

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
files="docs/bench/host-bench-laptop-$D.md docs/bench/host-bench-laptop-$D"
winuser="$(powershell.exe -NoProfile -Command '$env:USERNAME' | tr -d '\r')"
[ -n "$winuser" ] || winuser="$(whoami)"
grep -rnF -e "$(whoami)" -e "$(hostname)" -e "$winuser" -e "/home/" -e "/mnt/c/Users" -e "C:\\Users" $files
grep -rnE -e '([0-9]{1,3}\.){3}[0-9]{1,3}' -e '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' $files
```

The first `grep` must print nothing. Review every match of the second. An IPv4-shaped match must be a version number, such as a kernel or WSL version, and never an address. There must be no e-mail address. Remove anything else and run the check again.

6.5. **Commit and push.** Only the results file and its directory:

```bash
. ~/pmb-host-bench/env.sh
cd "$REPO"
git switch -c "host-bench-results-$D"
git add "docs/bench/host-bench-laptop-$D.md" "docs/bench/host-bench-laptop-$D"
git status --short
git commit -m "HOST-BENCH: laptop results $D" -m "Measurement only; PAPER only; public market data only. Guide: docs/runbooks/laptop-host-bench.md."
git push -u origin "host-bench-results-$D"
git log --oneline -1
```

`git status --short` must list only those paths, each with `A`. Any other changed or untracked path means something was modified: STOP. Do not open a pull request and do not merge; the orchestrator reviews the branch.

6.6. **Clean up and report.**

```bash
. ~/pmb-host-bench/env.sh
tmux ls 2>/dev/null; docker ps -a --format '{{.Names}}' | grep -E '^hb-' || echo "no bench containers"
```

Stop any `pmb-*` session that is still running. Leave `~/pmb-host-bench/` in place. Then tell the user:
- the branch name and the commit SHA;
- the headline numbers;
- every surprise;
- that Windows Update is still paused and the power settings are still on "never sleep" (theirs to keep or undo).

## Troubleshooting

**Clock drift.** WSL's clock can fall behind after the laptop sleeps.
- Check it with the `curl -sI` line in step 2.7.
- Ask the user to run `wsl --shutdown` in PowerShell and reopen Ubuntu. That resynchronizes the clock, but it also TERMINATES every WSL process: every `tmux` session, every running bench or recording, and this Claude Code session itself. Nothing restarts on its own. So ask for it only between parts, when `tmux ls` shows no `pmb-*` session; write the step to `PROGRESS.md` first. Afterwards the user starts `claude` again and says "continue `docs/runbooks/laptop-host-bench.md` from `~/pmb-host-bench/PROGRESS.md`".
- `sudo hwclock -s` also works, but it needs the user's password.
- The recorder's per-second counts use the WSL clock, so a jump shows as a gap or a burst. Record any drift you saw.

**The Docker daemon does not start.**
- Run `systemctl status docker --no-pager | head -20` and `journalctl -u docker --no-pager -n 40`.
- If `ps -p 1 -o comm=` is not `systemd`, systemd is off: the user reruns steps 0.9 and 0.10.
- "permission denied ... docker.sock" means the group change is not active: step 0.10.
- If the journal shows `iptables` errors, STOP and report them. Do not change the firewall setup yourself.

**Memory pressure.**
- Signs: swap use growing, `PSI memory some avg60` above a few percent, `MemAvailable` under 1 GB, or Windows' free memory near 0.
- Close everything else on Windows.
- Do not raise `memory=` above 12GB: Windows needs the rest. Record it in the results.

**Wi-Fi drops.**
- The recorder reconnects on its own, with backoff from 0.25 s to 30 s. It counts disconnects per series, and `connected s / wanted s` shows the time lost.
- A few disconnects in 24 hours are data; write them down.
- Tens of disconnects: ask the user for Ethernet, and whether to repeat Part 4.

**The recorder stopped with `outcome: failed`** (exit status 3, a `FAILED` line in `recorder.log`). One of its tasks died, and it stopped rather than record a silent gap. Keep `$HB/recording/` as it is, copy the `failures` list and the last 40 lines of `recorder.log` into `PROGRESS.md`, and STOP. The user decides whether to repeat Part 4 in a new directory.

**The venue refuses.** HTTP 403 or 429 from Gamma, or a WebSocket close with a policy code such as 1008 on every reconnect: stop the recorder (`tmux send-keys -t pmb-rec C-c`), then STOP. Do not retry faster or change the request rate.

**`powershell.exe` fails.** WSL interop may be off. The sampler records `{"error": ...}` for the Windows readings and keeps going. The WSL readings are still valid; say in the results that the Windows ones are missing.

**A bench run fails** (`exit` not 0, `bench failed`, or halts). Keep `$HB/trader-throughput/<label>.log` and STOP. Do not delete containers another session may own. The bench names its own `hb-redis-<hex>` and `hb-pg-<hex>`, and removes them itself.

**The session ended mid-part.** Read `~/pmb-host-bench/PROGRESS.md`, run `tmux ls`, and continue from the first step not marked done. `trader-bench.sh` refuses to overwrite an existing label, so give a rerun a new label, such as `catch-up-1b`. Say so in the results.
