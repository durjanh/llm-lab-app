using MedAssist.Application;
using MedAssist.Integrations.Foundry;
using Microsoft.Extensions.Options;

namespace MedAssist.Cli;

/// <summary>Talk to MedAssist as the signed-in patient; every tool call is shown. An empty line ends it.</summary>
public sealed class ChatCommand(IMedAssistEngine engine, PracticeService practice, IConsole console) : ICommand
{
    public string Name => "chat";

    public string Summary => "talk to MedAssist as the patient; every tool call is shown";

    public async Task<int> RunAsync(CommandContext context, CancellationToken cancellationToken = default)
    {
        var session = practice.OpenSession(context.PatientId);
        await using var conversation = await PatientConversation.StartAsync(engine, session, new ConsoleProgress(console), cancellationToken);
        console.WriteLine($"MedAssist ({engine.Name}) · Harbourside Medical Centre patient portal (fictional) · signed in as {session.Patient.Name}");
        console.WriteLine("Empty line to finish.\n");
        while (true)
        {
            console.Write("You: ");
            var text = console.ReadLine()?.Trim();
            if (string.IsNullOrEmpty(text))
            {
                return 0;
            }
            var turn = await conversation.AskAsync(text, cancellationToken);
            console.WriteLine($"\nMedAssist: {turn.Reply}\n");
        }
    }
}

/// <summary>The nine checked cases, each on a fresh copy of the test database.</summary>
public sealed class TestCommand(ScenarioRunner runner, IMedAssistEngine engine, IConsole console) : ICommand
{
    public string Name => "test";

    public string Summary => "the nine checked cases, each on a fresh database";

    public async Task<int> RunAsync(CommandContext context, CancellationToken cancellationToken = default)
    {
        var results = await runner.RunAsync(Scenarios.All, new ConsoleProgress(console), cancellationToken);
        var passed = results.Count(r => r.Passed);
        console.WriteLine($"\n{passed} of {results.Count} passed on {engine.Name}. Model replies vary: run it more than once before trusting a change.");
        return passed == results.Count ? 0 : 1;
    }
}

/// <summary>What the practice's database holds for the patient. No Azure needed.</summary>
public sealed class RecordsCommand(PracticeService practice, IConsole console) : ICommand
{
    public string Name => "records";

    public string Summary => "what the database holds for the patient (no Azure needed)";

    public Task<int> RunAsync(CommandContext context, CancellationToken cancellationToken = default)
    {
        var r = practice.Records(context.PatientId);
        var p = r.Patient;
        console.WriteLine($"{p.Name} ({p.Id}), born {p.DateOfBirth}, mobile {p.Phone}, registered with {r.RegisteredGp}");
        console.WriteLine($"  allergies: {p.Allergies} · conditions: {p.Conditions} · medicines: {p.Medications}");
        console.WriteLine("\nUpcoming appointments:");
        foreach (var a in r.Upcoming)
        {
            console.WriteLine($"  {a.AppointmentId}  {a.When} with {a.With} ({a.Kind}): {a.Reason}");
        }
        console.WriteLine("\nTexts sent (newest first):");
        foreach (var t in r.Texts)
        {
            console.WriteLine($"  {t.SentAt} to {t.SentTo}: {t.Body}");
        }
        console.WriteLine("\nAudit log (newest first):");
        foreach (var a in r.Audit)
        {
            console.WriteLine($"  {a.At} {a.Actor} {a.Action} {a.Detail}");
        }
        return Task.FromResult(0);
    }
}

/// <summary>A fresh database, with diaries from today. No Azure needed.</summary>
public sealed class ResetCommand(PracticeService practice, IConsole console) : ICommand
{
    public string Name => "reset";

    public string Summary => "a fresh database, with diaries from today (a copy of the old one is kept)";

    public Task<int> RunAsync(CommandContext context, CancellationToken cancellationToken = default)
    {
        var kept = practice.Reset();
        if (kept is not null)
        {
            console.WriteLine($"Kept a copy of the old database at {kept}");
        }
        console.WriteLine($"New database at {practice.Live.Location}, with diaries for the next {Domain.PracticeData.WeeksAhead} weeks.");
        return Task.FromResult(0);
    }
}

/// <summary>Uploads the practice documents and saves a new version of the MedAssist prompt agent in Foundry.</summary>
public sealed class CreateCommand(IKnowledgeDocuments documents, IKnowledgeBase knowledge, IAgentCatalog agents,
                                  Domain.ClinicToolbox toolbox, IOptions<FoundryOptions> foundry, IConsole console) : ICommand
{
    public string Name => "create";

    public string Summary => "upload the documents and save a new version of the agent in Foundry";

    public async Task<int> RunAsync(CommandContext context, CancellationToken cancellationToken = default)
    {
        var docs = documents.Load();
        var index = await knowledge.ReplaceAsync(docs, cancellationToken);
        console.WriteLine($"Indexed {index.Indexed} of {index.Total} documents in vector store {index.StoreId}");
        var saved = await agents.SaveVersionAsync(new AgentDefinition(MedAssistAgent.Name, MedAssistAgent.Description,
            foundry.Value.Model, MedAssistAgent.Instructions, index.StoreId, toolbox.Specs), cancellationToken);
        console.WriteLine($"Saved {saved.Name} version {saved.Version}. It is now in the Foundry portal.");
        return 0;
    }
}

/// <summary>Removes the agent, its documents and their vector store from Foundry.</summary>
public sealed class DeleteCommand(IAgentCatalog agents, IKnowledgeBase knowledge, IConsole console) : ICommand
{
    public string Name => "delete";

    public string Summary => "remove the agent, its documents and their vector store from Foundry";

    public async Task<int> RunAsync(CommandContext context, CancellationToken cancellationToken = default)
    {
        console.WriteLine(await agents.DeleteAsync(MedAssistAgent.Name, cancellationToken)
            ? $"Deleted {MedAssistAgent.Name} and all its versions."
            : $"There was no {MedAssistAgent.Name} agent.");
        foreach (var store in await knowledge.DeleteAsync(cancellationToken))
        {
            console.WriteLine($"Deleted vector store {store} and its files.");
        }
        return 0;
    }
}
