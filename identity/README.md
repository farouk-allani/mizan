# MIZAN identity module — ERC-8004 (BNB AI Agent SDK)

Registers MIZAN's on-chain agent identity in the ERC-8004 Identity Registry on
**BSC testnet** (the SDK's supported network; mainnet contracts are not yet
deployed). Registration is gas-free via the MegaFuel paymaster.

Why it exists: the "Best Use of BNB AI Agent SDK" special prize. The SDK is an
identity + agent-commerce toolkit, not an execution layer — so the correct use
is exactly this: a discoverable on-chain identity with an A2A agent card
describing MIZAN's capabilities and guardrails.

## Key isolation (non-negotiable)

The identity wallet is **never** the TWAK trading wallet. Leave
`IDENTITY_PRIVATE_KEY` unset and the SDK auto-generates a fresh key into
`~/.bnbagent/wallets/` (Keystore V3, encrypted with `IDENTITY_WALLET_PASSWORD`).

## Run

```bash
cd identity
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export IDENTITY_WALLET_PASSWORD='<strong password>'
# Host agent-card.json publicly (GitHub raw is fine), then:
export AGENT_CARD_URL='https://raw.githubusercontent.com/<you>/mizan/main/identity/agent-card.json'
python register_identity.py
```

Paste the resulting `agentId` + tx hash into `SUBMISSION.md`.

## Stretch (optional, post-MVP)

Expose MIZAN's regime readings as a paid APEX service (`bnbagent[server]`,
`create_apex_app`) so other agents can buy signals through escrowed jobs —
deepens the SDK story if time allows. Do NOT let this share a process or key
with the trading loop.
