# DM Modal Setup

## Goal
Make DM onboarding use the same modal-based setup flow as guild setup so users do not paste API keys into chat messages.

## Scope
- `/poke setup` in DMs opens a modal for linking the user's account.
- The existing DM `!setup` paste flow is removed.
- `!status` and `!reset` stay available in DMs.
- Guild setup continues to use the existing modal flow.

## Notes
- The modal content stays the same across DM and guild onboarding.
- The DM modal links the current Discord user to their own tenant state, including the owner namespace when configured.
- Message deletion is no longer part of DM setup.
