# examples/medassist/

MedAssist also exists in C# (`dotnet/`, layers in `dotnet/CLAUDE.md`). It shares `examples/medassist/data/medassist.db`, `knowledge/` and the Foundry agent with this Python version, so a change to `clinic.py`'s data, schema or rules must be made in `PracticeData.cs`/`PracticeSchema.cs`/`PatientSession.cs` too; a test pins the database to Python's for a fixed day.
