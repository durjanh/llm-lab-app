// MedAssist's web API: the composition root for the web layer. The lab's React page calls it at /api/medassist,
// as it calls the Python backend; set LLM_LAB_MEDASSIST_API=http://127.0.0.1:5080 for `npm run dev` to send it here.
//
//   cd dotnet && dotnet run --project src/MedAssist.Api
//
// Layers: controllers (here) -> services (MedAssist.Application) -> repositories (MedAssist.Data, the database)
// and gateways (MedAssist.Integrations.Foundry, Microsoft Foundry). Each layer knows only the one below, through
// interfaces.
using MedAssist.Api.Web;
using MedAssist.Application;
using MedAssist.Data;
using MedAssist.Integrations.Foundry;

var builder = WebApplication.CreateBuilder(args);
// appsettings.json, then your own values (appsettings.Local.json, kept out of git), then the environment over both.
builder.Configuration.AddJsonFile(Path.Combine(AppContext.BaseDirectory, "appsettings.Local.json"), optional: true)
                     .AddEnvironmentVariables();

builder.Services.AddMedAssistApplication(builder.Configuration)
                .AddMedAssistData()
                .AddFoundryIntegration(builder.Configuration);
builder.Services.AddControllers(o => o.Filters.Add<LabPageFilter>())
                .AddJsonOptions(o => ApiJson.Configure(o.JsonSerializerOptions))
                .ConfigureApiBehaviorOptions(o => o.InvalidModelStateResponseFactory = ApiJson.InvalidRequest);
builder.Services.AddExceptionHandler<FailureExceptionHandler>();
builder.Services.AddProblemDetails();

var app = builder.Build();
app.UseExceptionHandler();
app.MapControllers();
// The API has no pages of its own; opened in a browser, it says where the page is.
app.MapGet("/", () => Results.Content(ApiHome.Html, "text/html"));
app.Run();
