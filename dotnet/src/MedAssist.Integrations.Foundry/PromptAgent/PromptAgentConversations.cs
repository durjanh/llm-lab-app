using System.ClientModel;
using Azure.AI.Extensions.OpenAI;
using OpenAI.Responses;

namespace MedAssist.Integrations.Foundry.PromptAgent;

/// <summary>A conversation with a prompt agent: it answers input, and is deleted when it ends.</summary>
public interface IAgentConversation : IAgentResponder, IAsyncDisposable;

/// <summary>Starts conversations with a prompt agent saved in Foundry.</summary>
public interface IPromptAgentConversations
{
    /// <summary>A new conversation, opening with <paramref name="developerNote"/> (what the portal knows: the date
    /// and who is signed in).</summary>
    Task<IAgentConversation> StartAsync(string agentName, string developerNote, CancellationToken cancellationToken = default);
}

/// <summary>Foundry conversations, with responses from the agent by reference (Adapter).</summary>
public sealed class FoundryPromptAgentConversations(IFoundryProject project) : IPromptAgentConversations
{
    public async Task<IAgentConversation> StartAsync(string agentName, string developerNote, CancellationToken cancellationToken = default)
    {
        var openai = project.Client.ProjectOpenAIClient;
        var conversations = openai.GetProjectConversationsClient();
        ProjectConversation conversation = await conversations.CreateProjectConversationAsync(
            new ProjectConversationCreationOptions { Items = { ResponseItem.CreateDeveloperMessageItem(developerNote) } },
            cancellationToken);
        var responses = openai.GetProjectResponsesClientForAgent(new AgentReference(agentName), conversation.Id);
        return new Conversation(conversations, conversation.Id, responses);
    }

    private sealed class Conversation(ProjectConversationsClient conversations, string id, ProjectResponsesClient responses)
        : IAgentConversation
    {
        public async Task<ResponseResult> RespondAsync(IReadOnlyList<ResponseItem> input, CancellationToken cancellationToken = default) =>
            await responses.CreateResponseAsync(input, cancellationToken: cancellationToken);

        public async ValueTask DisposeAsync()
        {
            try
            {
                await conversations.DeleteConversationAsync(id);
            }
            catch (ClientResultException)  // already gone, or the network dropped: nothing to tidy up
            {
            }
        }
    }
}
