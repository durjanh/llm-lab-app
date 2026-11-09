using MedAssist.Application;
using Microsoft.Extensions.AI;
using OpenAI.Responses;

namespace MedAssist.Integrations.Foundry.AgentFramework;

/// <summary>
/// File Search and the Code Interpreter run in Foundry, not through our tools, so Agent Framework never calls us for
/// them. They are found in the reply's contents: the Responses item each content came from, when the framework keeps
/// it, or the content's own type otherwise.
/// </summary>
public static class HostedSteps
{
    public static IReadOnlyList<Step> From(IEnumerable<ChatMessage> messages)
    {
        var steps = new List<Step>();
        foreach (var content in messages.SelectMany(m => m.Contents))
        {
            Step? step = content.RawRepresentation switch
            {
                FileSearchCallResponseItem search => new FileSearchStep([.. search.Queries]),
                CodeInterpreterCallResponseItem code => new CodeInterpreterStep(code.Code ?? ""),
                _ when content.GetType().Name.Contains("CodeInterpreter", StringComparison.Ordinal) => new CodeInterpreterStep(""),
                _ when content.GetType().Name.Contains("FileSearch", StringComparison.Ordinal) => new FileSearchStep([]),
                _ => null,
            };
            if (step is not null)
            {
                steps.Add(step);
            }
        }
        return steps;
    }
}
