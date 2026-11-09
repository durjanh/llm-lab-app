using MedAssist.Application;
using MedAssist.Domain;
using Microsoft.Extensions.Options;
using OpenAI.Responses;

namespace MedAssist.Integrations.Foundry.PromptAgent;

/// <summary>Sends input to the agent in one conversation and returns its response. Foundry in the program; a script in tests.</summary>
public interface IAgentResponder
{
    Task<ResponseResult> RespondAsync(IReadOnlyList<ResponseItem> input, CancellationToken cancellationToken = default);
}

/// <summary>
/// Our own tool loop: one patient message, through to MedAssist's reply. A port of clinic.run_turn.
///
/// Foundry runs File Search and the Code Interpreter itself and reports them in the output. Function calls come
/// back here: each runs against the session, through the toolbox, and the results go back as function_call_output
/// items, round after round, until the agent answers in words. This is the loop Agent Framework runs for you in the
/// other engine.
/// </summary>
public sealed class ToolLoop(ClinicToolbox toolbox, IOptions<MedAssistOptions> options)
{
    public async Task<TurnResult> RunAsync(IAgentResponder agent, PatientSession session, string text, IStepObserver observer,
                                           CancellationToken cancellationToken = default)
    {
        var steps = new List<Step>();
        var response = await agent.RespondAsync([ResponseItem.CreateUserMessageItem(text)], cancellationToken);
        var usage = UsageOf(response);
        for (var round = 0; round < options.Value.MaxRounds; round++)
        {
            var outputs = new List<ResponseItem>();
            foreach (var item in response.OutputItems)
            {
                var step = Read(item, session, outputs);
                if (step is not null)
                {
                    steps.Add(step);
                    observer.OnStep(step);
                }
            }
            if (outputs.Count == 0)
            {
                return new TurnResult(ReplyText(response), steps, usage);
            }
            response = await agent.RespondAsync(outputs, cancellationToken);
            usage += UsageOf(response);
        }
        return new TurnResult("(MedAssist stopped: too many tool calls in one turn.)", steps, usage);
    }

    /// <summary>The reply's text. The model sometimes sends the same message item twice; show it once.</summary>
    public static string ReplyText(ResponseResult response)
    {
        var parts = new List<string>();
        foreach (var message in response.OutputItems.OfType<MessageResponseItem>())
        {
            var text = string.Concat(message.Content.Where(c => c.Kind == ResponseContentPartKind.OutputText).Select(c => c.Text)).Trim();
            if (text.Length > 0 && !parts.Contains(text))
            {
                parts.Add(text);
            }
        }
        return string.Join("\n\n", parts);
    }

    /// <summary>One output item: a step to report, and for a function call, its output to send back.</summary>
    private Step? Read(ResponseItem item, PatientSession session, List<ResponseItem> outputs)
    {
        switch (item)
        {
            case FileSearchCallResponseItem search:
                return new FileSearchStep([.. search.Queries]);
            case CodeInterpreterCallResponseItem code:
                return new CodeInterpreterStep(code.Code ?? "");
            case FunctionCallResponseItem call:
                var arguments = call.FunctionArguments?.ToString() ?? "{}";
                var result = toolbox.Call(session, call.FunctionName, arguments);  // the rules are in here, not in the prompt
                outputs.Add(ResponseItem.CreateFunctionCallOutputItem(call.CallId, result.ToJson()));
                return new FunctionStep(call.FunctionName, arguments, result);
            default:
                return null;
        }
    }

    private static TokenUsage UsageOf(ResponseResult response) => response.Usage is { } u
        ? new TokenUsage(u.InputTokenCount, u.InputTokenDetails?.CachedTokenCount ?? 0, u.OutputTokenCount)
        : TokenUsage.None;
}
