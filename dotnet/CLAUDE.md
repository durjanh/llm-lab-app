# dotnet/

MedAssist in C# (.NET 10, `MedAssist.sln`), in layers that only reach down through interfaces: `MedAssist.Api` (controllers, same `/api/medassist` routes and JSON as the Python backend; `LLM_LAB_MEDASSIST_API=http://127.0.0.1:5080` makes Vite send the page's MedAssist calls there) and `MedAssist.Cli` -> `MedAssist.Application` (services) -> `MedAssist.Domain` (rules, tools, repository ports; no packages), `MedAssist.Data` (SQLite) and `MedAssist.Integrations.Foundry` (both engines: `prompt-agent` and `agent-framework`, chosen by `MedAssist:Engine`). Settings are `appsettings.json` plus the git-ignored `dotnet/appsettings.Local.json`.

This C# version shares `examples/medassist/data/medassist.db`, `knowledge/` and the Foundry agent with the Python one, so a change to `clinic.py`'s data, schema or rules must be made in `PracticeData.cs`/`PracticeSchema.cs`/`PatientSession.cs` too (and the reverse); a test pins the database to Python's for a fixed day.
