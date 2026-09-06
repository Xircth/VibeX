//! Isolated Seatbelt/bwrap/Landlock/AppContainer spawn is not a live path.
//! Worker processes always run Full Trust (ADR-0048). OS syscall allowlists
//! under `packages/plugin-contract/isolated/` remain historical evidence only.
