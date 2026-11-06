# World ID integration debrief

EthPC uses World ID (World IdP, `auth.world.org`, OIDC Device Authorization Grant) as a **human checkpoint for an AI agent**: when the agent wants to pay more than the user's "ask me" amount, it stops until the user passes a fresh World ID check and signs that exact payment. World ID also gates writing a shop review (one per delivered order). Code: `src/world.mjs` (device flow and token checks), `src/guard.mjs` (step-ups), `src/orders.mjs` (reviews).

## Time to first success
_Team: fill in honestly, e.g. "about N hours from registering the app to the first verified ID token", and what took the time._

## Friction we hit
1. **HTTPS-only, exact-match callbacks.** Our app runs on `http://localhost:4000`, so the browser redirect flow couldn't come back to it. We switched to the Device Authorization Grant (RFC 8628), which needs no callback. It works well, but the docs could say up front that the device flow is the way to develop locally.
2. **Getting a sandbox World ID takes a while.** The sandbox World App comes through TestFlight, and identity creation ("Manual verify" with a selfie) took time before the identity was ready. Meanwhile we couldn't test the happy path end to end; a local fake issuer that signs real tokens covered the gap (`test/world.test.mjs`).
3. **Portal sign-in.** The first Google account we used to register in the portal got `account_not_eligible`; a second account worked. The error didn't say why.
4. **Freshness on the device grant.** `prompt` and `max_age` aren't honoured on the device grant, so "fresh" has to be enforced by the app: we reject any token whose `auth_time` is before the moment we started the check.
5. **Popups.** World's pages won't load in an iframe, so we open a popup. It has to be opened synchronously inside the click handler, or browsers block it; in macOS full screen, Firefox turns it into a tab.
6. **Mixed signals on sandbox vs mocked proofs.** The hackathon page says proofs are mocked and a sandbox app is no longer needed; the docs still describe the sandbox app and issuer. We kept the sandbox issuer because it worked; it was unclear which one judges expect.
7. **Client auth method is fixed per client.** The portal default is `client_secret_basic`; we needed `client_secret_post`, which meant registering a new client.

## Missing capability or documentation
- **Showing the action being approved.** On the device flow, the World App approval screen shows a code, not what the person is approving. For an agent checkpoint, the human should see "Approve: pay 0.05 USDC to RigAdvisor". We bind the check to the exact action on our side (the approval stores the payment's fingerprint), but we found no way to show that context in World App.
- **A single example of "agent pauses → human checks → agent resumes"** end to end, with the token checks a backend must do, would have saved time. The step-up guide describes it; a runnable sample would make it concrete.

## The one improvement with the greatest impact
**An action description on the approval screen** (a binding message or authorisation details passed with the device request and shown in World App). It turns "a human is present" into "this human approved this exact action", which is what an agent checkpoint needs.
