using System.ClientModel;
using Azure.AI.Projects.Agents;
using MedAssist.Application;
using OpenAI.Responses;

namespace MedAssist.Integrations.Foundry;

/// <summary>
/// Prompt agents saved in Foundry, with their versions (Adapter for <see cref="IAgentCatalog"/>). A definition
/// becomes a <see cref="DeclarativeAgentDefinition"/>: the model, the instructions, File Search over the knowledge
/// store, the Code Interpreter, and the clinic's function tools with their strict schemas.
/// </summary>
public sealed class FoundryAgentCatalog(IFoundryProject project) : IAgentCatalog
{
    private AgentAdministrationClient Agents => project.Client.AgentAdministrationClient;

    public async Task<SavedAgent> SaveVersionAsync(AgentDefinition definition, CancellationToken cancellationToken = default)
    {
        var declarative = new DeclarativeAgentDefinition(definition.Model) { Instructions = definition.Instructions };
        declarative.Tools.Add(ResponseTool.CreateFileSearchTool([definition.KnowledgeStoreId]));
        declarative.Tools.Add(ResponseTool.CreateCodeInterpreterTool(
            new CodeInterpreterToolContainer(CodeInterpreterToolContainerConfiguration.CreateAutomaticContainerConfiguration([]))));
        foreach (var tool in definition.FunctionTools)
        {
            declarative.Tools.Add(ResponseTool.CreateFunctionTool(tool.Name, BinaryData.FromString(tool.ParametersJson),
                                                                  strictModeEnabled: true, functionDescription: tool.Description));
        }
        ProjectsAgentVersion saved = await Agents.CreateAgentVersionAsync(
            definition.Name, new ProjectsAgentVersionCreationOptions(declarative) { Description = definition.Description },
            cancellationToken: cancellationToken);
        return new SavedAgent(saved.Name, saved.Version);
    }

    public async Task<string?> LatestVersionAsync(string agentName, CancellationToken cancellationToken = default)
    {
        try
        {
            ProjectsAgentRecord agent = await Agents.GetAgentAsync(agentName, cancellationToken);
            return agent.GetLatestVersion()?.Version;
        }
        catch (ClientResultException exc) when (exc.Status == 404)
        {
            return null;
        }
    }

    public async Task<bool> DeleteAsync(string agentName, CancellationToken cancellationToken = default)
    {
        try
        {
            await Agents.DeleteAgentAsync(agentName, cancellationToken);
            return true;
        }
        catch (ClientResultException exc) when (exc.Status == 404)
        {
            return false;
        }
    }
}
