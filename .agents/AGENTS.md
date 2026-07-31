# Workspace Rules & Constraints

1. **Development Environment Isolation**:
   - ALL code modifications, builds, testing, and script executions MUST happen strictly inside `d:\meshtastic\Meshtastic-DashBoard-Dev`.
   - **NEVER** modify, copy files to, or restart PM2 processes in `d:\meshtastic\Meshtastic-DashBoard-Prod` unless the user explicitly asks to deploy to production.
