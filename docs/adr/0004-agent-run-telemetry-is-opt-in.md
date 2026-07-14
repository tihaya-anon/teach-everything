# Agent Run telemetry is opt-in

Only the dedicated streaming agent-run endpoint creates an `agent.run` span and binds an Agent Run Identifier to its logs. The span sits beneath normal HTTP telemetry and contains the instrumented LangGraph execution; authentication and other ordinary HTTP flows retain standard request telemetry without being represented as Agent Runs.
