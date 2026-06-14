#!/usr/bin/env python3
"""
MIZAN — ERC-8004 on-chain agent identity registration (BNB AI Agent SDK).

Registers MIZAN in the ERC-8004 Identity Registry on BSC TESTNET (the SDK's
supported network; mainnet contracts are not yet deployed). Registration is
gas-free via the MegaFuel paymaster, per the SDK docs.

KEY ISOLATION — IMPORTANT:
  This uses a *dedicated identity wallet*, never the TWAK trading wallet.
  If IDENTITY_PRIVATE_KEY is unset and no keystore exists in
  ~/.bnbagent/wallets/, the SDK auto-generates a fresh wallet. The trading
  key never touches this process.

Usage:
  pip install -r requirements.txt
  export IDENTITY_WALLET_PASSWORD='...'      # required
  # export IDENTITY_PRIVATE_KEY='0x...'      # optional; omit to auto-generate
  python register_identity.py

Idempotency: re-running registers a new agentId; record the first one in
SUBMISSION.md and don't re-run after success.
"""

import json
import os
import sys

from dotenv import load_dotenv

from bnbagent import AgentEndpoint, ERC8004Agent, EVMWalletProvider

AGENT_NAME = "mizan-trading-agent"
AGENT_DESCRIPTION = (
    "MIZAN — halal-compliant, sentinel-guarded autonomous SPOT trading agent on "
    "BNB Chain. Self-custody execution via Trust Wallet Agent Kit; market data via "
    "CoinMarketCap Agent Hub paid per-call over x402; deterministic guardrails "
    "(allowlist, drawdown circuit breaker, daily caps) that LLM output cannot override."
)
# Host identity/agent-card.json somewhere public (GitHub raw works) and point here:
AGENT_CARD_URL = os.environ.get(
    "AGENT_CARD_URL",
    "https://raw.githubusercontent.com/farouk-allani/mizan/main/identity/agent-card.json",
)


def main() -> int:
    load_dotenv()
    password = os.environ.get("IDENTITY_WALLET_PASSWORD")
    if not password:
        print("ERROR: set IDENTITY_WALLET_PASSWORD (dedicated identity wallet, NOT the TWAK one)")
        return 1

    private_key = os.environ.get("IDENTITY_PRIVATE_KEY")  # optional — omit to auto-generate
    wallet = EVMWalletProvider(password=password, private_key=private_key)
    print(f"identity wallet: {wallet.address}")

    sdk = ERC8004Agent(network="bsc-testnet", wallet_provider=wallet)

    agent_uri = sdk.generate_agent_uri(
        name=AGENT_NAME,
        description=AGENT_DESCRIPTION,
        endpoints=[
            AgentEndpoint(name="A2A", endpoint=AGENT_CARD_URL, version="0.3.0"),
        ],
    )

    print("registering on ERC-8004 Identity Registry (bsc-testnet, MegaFuel gas-free)...")
    result = sdk.register_agent(agent_uri=agent_uri)
    print(json.dumps(result, indent=2, default=str))
    print(
        f"\n✅ registered — paste into SUBMISSION.md:\n"
        f"   agentId: {result.get('agentId')}\n"
        f"   tx:      {result.get('transactionHash')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
