using System.Text.Json;
using MedAssist.Application;
using MedAssist.Domain;
using Microsoft.Extensions.AI;

namespace MedAssist.Integrations.Foundry.AgentFramework;

/// <summary>
/// One of the clinic's tools as an Agent Framework tool (Adapter), bound to one signed-in patient's session. The
/// model sees the same name, description and JSON schema as the prompt agent's tool; when the framework calls it,
/// the toolbox runs it with the session's rules, exactly as our own loop does.
/// </summary>
public sealed class ClinicFunction(FunctionToolSpec spec, ClinicToolbox toolbox, PatientSession session, Action<FunctionStep> onStep)
    : AIFunction
{
    private readonly JsonElement _schema = JsonDocument.Parse(spec.ParametersJson).RootElement.Clone();

    public override string Name => spec.Name;

    public override string Description => spec.Description;

    public override JsonElement JsonSchema => _schema;

    protected override ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.Serialize(arguments.ToDictionary(a => a.Key, a => a.Value));
        var result = toolbox.Call(session, spec.Name, json);  // the rules are in here, not in the prompt
        onStep(new FunctionStep(spec.Name, json, result));
        // The JSON itself, so the model reads exactly what our own loop sends it.
        return ValueTask.FromResult<object?>(JsonDocument.Parse(result.ToJson()).RootElement.Clone());
    }
}
