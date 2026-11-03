# Workspace Rules & Constraints

1. **Development Environment Isolation**:
   - ALL code modifications, builds, testing, and script executions MUST happen strictly inside `d:\meshtastic\Meshtastic-DashBoard-Dev`.
   - **NEVER** modify, copy files to, or restart PM2 processes in `d:\meshtastic\Meshtastic-DashBoard-Prod` unless the user explicitly asks to deploy to production.

2. **Project Progress & Context Awareness**:
   - Whenever starting a session or resuming work, ALWAYS refer to [DEV_PROGRESS.md](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/DEV_PROGRESS.md) at the workspace root to understand the current architecture, completed features (e.g. 180-station ITM coverage, solar forecasting, PRR, Site Planner), and active backlog.
