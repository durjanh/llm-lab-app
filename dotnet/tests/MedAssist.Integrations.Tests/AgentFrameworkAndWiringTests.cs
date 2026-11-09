using Azure.Identity;
using MedAssist.Application;
using MedAssist.Data;
using MedAssist.Domain;
using MedAssist.Integrations.Foundry;
using MedAssist.Integrations.Foundry.AgentFramework;
using MedAssist.Integrations.Foundry.PromptAgent;
using MedAssist.Testing;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OpenAI.Responses;

namespace MedAssist.Integrations.Tests;

/// <summary>The Agent Framework adapter, Foundry's failures and settings, and which engine the services get.</summary>
public class AgentFrameworkAndWiringTests
{
    [Test]
    public async Task A_clinic_tool_called_by_the_framework_runs_the_rules_and_returns_the_same_json()
    {
        using var practice = new TempPractice();
        using var sam = practice.Session("P002");
        var toolbox = ClinicToolbox.Standard();
        var steps = new List<FunctionStep>();
        var function = new ClinicFunction(toolbox.Specs.Single(s => s.Name == "get_my_record"), toolbox, sam, steps.Add);

        var result = await function.InvokeAsync(new AIFunctionArguments());

        function.Name.Should().Be("get_my_record");
        function.JsonSchema.GetProperty("additionalProperties").GetBoolean().Should().BeFalse();
        result.Should().BeOfType<System.Text.Json.JsonElement>().Which.GetProperty("name").GetString().Should().Be("Sam Taylor");
        steps.Should().ContainSingle().Which.Result.Should().BeOfType<PatientRecord>();
    }

    [Test]
    public void Hosted_tools_are_found_in_the_frameworks_reply()
    {
        ChatMessage[] messages =
        [
            new(ChatRole.Assistant, [new AIContent { RawRepresentation = ResponseItem.CreateFileSearchCallItem(["Saturday hours"]) },
                                     new TextContent("We open at 09:00.")]),
        ];

        HostedSteps.From(messages).Should().ContainSingle().Which.Should().BeOfType<FileSearchStep>()
                   .Which.Queries.Should().Equal("Saturday hours");
    }

    [Test]
    public void An_azure_sign_in_failure_says_to_run_az_login()
    {
        new FoundryFailureClassifier().Classify(new AuthenticationFailedException("no token"))!
            .Message.Should().Contain("az login");
        new FoundryFailureClassifier().Classify(new InvalidOperationException()).Should().BeNull("other layers' failures are not Foundry's");
    }

    [Test]
    public void Foundry_settings_that_cannot_work_are_named()
    {
        var result = new ValidateFoundryOptions().Validate(null, new FoundryOptions { ProjectEndpoint = "http://not-https", Model = "" });

        result.Failures.Should().HaveCount(2).And.Contain(f => f.Contains("Foundry:ProjectEndpoint"));
        new ValidateFoundryOptions().Validate(null, new FoundryOptions { ProjectEndpoint = "https://x.services.ai.azure.com/api/projects/p", Model = "m" })
                                    .Succeeded.Should().BeTrue();
    }

    [TestCase("prompt-agent", typeof(PromptAgentEngine))]
    [TestCase("agent-framework", typeof(AgentFrameworkEngine))]
    public void The_services_get_the_engine_appsettings_names(string engine, Type expected)
    {
        using var services = Services(new() { ["MedAssist:Engine"] = engine });
        services.GetRequiredService<IMedAssistEngine>().Should().BeOfType(expected);
    }

    [Test]
    public void Building_the_services_needs_no_foundry_settings_until_foundry_is_called()
    {
        using var services = Services(new());  // no Foundry section at all

        var practice = services.GetRequiredService<PracticeService>();
        practice.Patients().Should().HaveCount(PracticeData.Patients.Count);
        services.GetRequiredService<ChatService>().Should().NotBeNull();
    }

    private static ServiceProvider Services(Dictionary<string, string?> settings)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        return new ServiceCollection().AddMedAssistApplication(configuration).AddMedAssistData()
                                      .AddFoundryIntegration(configuration).BuildServiceProvider();
    }
}
