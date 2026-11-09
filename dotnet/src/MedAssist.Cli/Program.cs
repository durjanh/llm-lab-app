// MedAssist on the command line: the composition root for the CLI, over the same service layer as the API.
//
//   cd dotnet
//   dotnet run --project src/MedAssist.Cli -- create          upload the documents, save a new version of the agent
//   dotnet run --project src/MedAssist.Cli -- chat            as Valeria Romano (P001); every tool call is shown
//   dotnet run --project src/MedAssist.Cli -- chat --patient P002 --engine agent-framework
//   dotnet run --project src/MedAssist.Cli -- test            the nine checked cases
//   dotnet run --project src/MedAssist.Cli -- records --patient P002
//   dotnet run --project src/MedAssist.Cli -- reset
//   dotnet run --project src/MedAssist.Cli -- delete
using MedAssist.Application;
using MedAssist.Cli;
using MedAssist.Data;
using MedAssist.Integrations.Foundry;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings { ContentRootPath = AppContext.BaseDirectory });
// appsettings.json, then your own values (appsettings.Local.json), then the environment, then --engine.
builder.Configuration.AddJsonFile(Path.Combine(AppContext.BaseDirectory, "appsettings.Local.json"), optional: true)
                     .AddEnvironmentVariables()
                     .AddCommandLine(args, new Dictionary<string, string> { ["--engine"] = "MedAssist:Engine" });
builder.Logging.ClearProviders();  // the commands print what they do; nothing else should write to the terminal

builder.Services.AddMedAssistApplication(builder.Configuration)
                .AddMedAssistData()
                .AddFoundryIntegration(builder.Configuration);
builder.Services.AddSingleton<IConsole, SystemConsole>()
                .AddSingleton<ICommand, ChatCommand>()
                .AddSingleton<ICommand, TestCommand>()
                .AddSingleton<ICommand, RecordsCommand>()
                .AddSingleton<ICommand, ResetCommand>()
                .AddSingleton<ICommand, CreateCommand>()
                .AddSingleton<ICommand, DeleteCommand>()
                .AddSingleton<CommandRouter>();

using var host = builder.Build();
return await host.Services.GetRequiredService<CommandRouter>().RunAsync(args);
