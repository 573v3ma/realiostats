#!/usr/bin/env python3
"""
RIO mint/burn audit  -  the receipts behind the "Supply provenance" section of
realiostats.com. Answers: was the post-migration cross-chain RIO minted with a
matching burn, or is it net-new supply?

WHAT IT DOES
------------
For one ERC-20 RIO contract it pulls EVERY
  * mint = Transfer with `from` = 0x000...000
  * burn = Transfer with `to`   = 0x000...000
sums each side, and reconciles net (mints - burns) against the live
totalSupply. If net == totalSupply, the capture is complete and trustworthy.

Run it once per chain (BNB, Ethereum) and compare the net that accumulated on
the EVM contracts against what the native chain could possibly have emitted.

METHOD NOTE
-----------
Free block-explorer and RPC tiers now cap raw eth_getLogs at 10-10,000 blocks,
which cannot sweep 18 months. This uses Alchemy's indexed Transfers API
(alchemy_getAssetTransfers), which is NOT range-limited and works on the free
tier. One Alchemy key with BNB Smart Chain + Ethereum enabled covers both legs.

RUN
---
  # BNB leg
  export RPC_URL="https://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY"
  python3 rio_mint_burn_audit.py --label "BNB Chain"

  # Ethereum leg (same key, ETH endpoint - enable Ethereum on the Alchemy app)
  export RPC_URL="https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"
  python3 rio_mint_burn_audit.py --label "Ethereum"

Results captured 13 Jul 2026 (new RIO contract 0x94a8...1aa0 on both chains):
  BNB Chain : minted 275,406,414 | burned 119,450,217 | net 155,956,198 (= live)
  Ethereum  : minted 134,683,607 | burned  63,828,721 | net  70,854,886 (= live)
Both EVM contracts hold ~226.8M net, which is more than the Realio native chain
has ever held (~85M) or its 175M cap, so most cross-chain RIO cannot originate
from native emission. See RIO-bsc-chain-of-custody notes for the full write-up.
"""
import os, sys, json, time, argparse, urllib.request

RPC = os.environ.get("RPC_URL", "")
CONTRACT = os.environ.get("CONTRACT", "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0")
ZERO = "0x0000000000000000000000000000000000000000"
DEC = 10**18
_id = 0

def rpc(method, params):
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": method, "params": params}).encode()
    for a in range(6):
        try:
            req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=45) as r:
                d = json.load(r)
        except Exception:
            time.sleep(1.0 * (a + 1)); continue
        if "error" in d:
            m = str(d["error"]).lower()
            if "rate" in m or "many" in m or "limit" in m:
                time.sleep(1.2 * (a + 1)); continue
            return d
        return d
    return {"error": "retries exhausted"}

def sum_transfers(direction_key, addr, label):
    """Paginate alchemy_getAssetTransfers; sum exact wei from rawContract.value."""
    total, count, pk = 0, 0, None
    while True:
        params = {"fromBlock": "0x0", "toBlock": "latest", "contractAddresses": [CONTRACT],
                  "category": ["erc20"], "excludeZeroValue": False, "maxCount": "0x3e8",
                  direction_key: addr}
        if pk:
            params["pageKey"] = pk
        d = rpc("alchemy_getAssetTransfers", [params])
        if "error" in d:
            sys.exit(f"ERROR ({label}): {d['error']}")
        res = d["result"]
        for x in res["transfers"]:
            rv = x.get("rawContract", {}).get("value")
            if rv:
                total += int(rv, 16)
        count += len(res["transfers"])
        print(f"    {label}: {count:,} events, running {total/DEC:,.0f} RIO", flush=True)
        pk = res.get("pageKey")
        if not pk:
            break
        time.sleep(0.1)
    return total, count

def total_supply():
    d = rpc("eth_call", [{"to": CONTRACT, "data": "0x18160ddd"}, "latest"])
    r = d.get("result")
    return int(r, 16) / DEC if r and r != "0x" else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="chain", help="chain label for the report, e.g. 'BNB Chain'")
    args = ap.parse_args()
    if not RPC:
        sys.exit("ERROR: set RPC_URL to an Alchemy endpoint (BNB or ETH). See notes at bottom of file.")

    print(f"Auditing {CONTRACT} on {args.label} ...")
    print("  mints (Transfer from 0x0):")
    mint, mc = sum_transfers("fromAddress", ZERO, "mint")
    print("  burns (Transfer to 0x0):")
    burn, bc = sum_transfers("toAddress", ZERO, "burn")

    net = (mint - burn) / DEC
    live = total_supply() or 0
    print("\n" + "=" * 60)
    print(f"  RIO mint/burn audit  -  {args.label}")
    print("=" * 60)
    print(f"  minted:     {mint/DEC:>16,.2f} RIO  ({mc:,} events)")
    print(f"  burned:     {burn/DEC:>16,.2f} RIO  ({bc:,} events)")
    print(f"  net:        {net:>16,.2f} RIO")
    print(f"  totalSupply:{live:>16,.2f} RIO  (live)")
    diff = net - live
    ok = abs(diff) < max(1.0, 0.001 * live)
    print(f"  reconcile:  {diff:>16,.2f} RIO  {'[OK, capture complete]' if ok else '[MISMATCH]'}")
    print("=" * 60)

if __name__ == "__main__":
    main()

# ============================================================================
# GET A FREE ALCHEMY KEY (covers BNB + Ethereum), ~3 minutes
# ----------------------------------------------------------------------------
# 1. Sign up free at https://www.alchemy.com/
# 2. Create an app. On the app's Networks page, enable BOTH:
#      - BNB Smart Chain > Mainnet
#      - Ethereum > Mainnet
# 3. Copy each network's HTTPS URL:
#      https://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY
#      https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
# 4. Set RPC_URL to the one for the leg you are auditing, then run (see RUN above).
#
# The Transfers API used here is on the free tier and is not block-range limited.
# The whole audit is a few dozen paginated calls and finishes in a minute or two.
# ============================================================================
