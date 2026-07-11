# realiostats

Transparent, reproducible tracking of RIO circulating supply across every chain it lives on.

Headline number: **on-chain tradable supply (~326M)**, shown alongside the 175M native emission cap and the ~100M aggregator figure as context. Full definition and per-wallet exclusion rules are in `../realiostats-methodology.md`.

## What's here

- **`fetch_supply.py`** — reads RIO supply from Realio native, Ethereum, BNB, Base, Solana, Algorand and Stellar; excludes Realio-controlled reserve/treasury/bridge wallets; runs verification checks; prints a snapshot. Standard library only, no keys, read-only public endpoints, each with a verified fallback list.
- **`append_snapshot.py`** — runs the fetch and appends one row to `supply-history.json`. Refuses to write (exits non-zero) if any chain fails on all its endpoints, so a wrong/incomplete total is never committed. Same-day re-runs replace that day's row.
- **`supply-history.json`** — the append-only time series the site reads. Its git history is the audit trail.
- **`.github/workflows/daily-supply.yml`** — runs `append_snapshot.py` daily at 06:00 UTC and commits the new snapshot.

## How the numbers stay honest

- **Count each token once.** Base is minted against RIO locked on Ethereum, so Base counts 0 and the lock is verified to match Base supply each run.
- **Additivity is proven, not assumed.** The native bridge escrow is checked to be 0 every run; if it ever isn't, the snapshot is flagged rather than silently summed.
- **Exclusions are explicit.** Algorand reserve + bridge wallet and the Stellar realio.fund treasury are subtracted; addresses live in `fetch_supply.py`.
- **Failures are loud.** If a chain can't be read from any endpoint, the day is marked `TOTAL_INCOMPLETE` and skipped, never published as a lower number.

## Deploy

1. Create a new **public** GitHub repo (e.g. `realiostats`) and push the contents of this folder to its root.
2. In the repo: **Settings → Actions → General → Workflow permissions → Read and write**. (The workflow also declares `permissions: contents: write`.)
3. The workflow runs daily automatically. Trigger a first run now via **Actions → Daily RIO supply snapshot → Run workflow**. A new commit to `supply-history.json` confirms it works.
4. Later: point Cloudflare Pages (or Vercel) at the repo to serve the public site reading `supply-history.json`, then map `realiostats.com` to it.

Notes: GitHub disables scheduled workflows after 60 days of no repo activity (the daily commits keep it alive); free-tier cron can start a few minutes late, which is fine here.

## Adding your own validator's LCD (recommended)

Native currently reads from three public LCDs (noders, cosmos.directory, stavr). Your own Realio node is the most authoritative source. Once its LCD is exposed over HTTPS (see `../realio-node-lcd-setup.md`), put it FIRST in the `"native"` list in `fetch_supply.py`:

```python
"native": ["https://lcd.realiostats.com",            # your node - authoritative
           "https://realio-api.noders.services",
           "https://rest.cosmos.directory/realio",
           "https://realio.api.m.stavr.tech"],
```

## Open question the data can't answer

Whether the October 2023 genesis mint of BSC RIO (75M to the Realio deployer) was collateralised by a burn elsewhere or was net-new supply. Only the team's cross-chain bridge ledger settles it. See `../RIO-bsc-chain-of-custody-2026-07-10.md`.
