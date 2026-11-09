using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MedAssist.Application;
using MedAssist.Domain;
using MedAssist.Testing;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace MedAssist.Api.Tests;

/// <summary>
/// The API as the lab's page calls it, in memory: the real controllers, services and SQLite data layer, with a
/// scripted engine in place of Foundry, a fixed clock and a throwaway database. Checks the JSON the page reads.
/// </summary>
public class MedAssistApiTests
{
    private string _folder = "";
    private FakeEngine _engine = null!;
    private WebApplicationFactory<Program> _app = null!;
    private HttpClient _client = null!;

    [SetUp]
    public void Start()
    {
        _folder = Directory.CreateTempSubdirectory("medassist-api-").FullName;
        _engine = new FakeEngine();
        _app = new WebApplicationFactory<Program>().WithWebHostBuilder(web =>
        {
            web.UseSetting("MedAssist:RepoRoot", _folder);
            web.UseSetting("MedAssist:DatabasePath", "medassist.db");
            web.ConfigureTestServices(services =>
            {
                services.AddSingleton<IMedAssistEngine>(_engine);
                services.AddSingleton<TimeProvider>(new FixedTimeProvider());
            });
        });
        _client = _app.CreateClient();
        _client.DefaultRequestHeaders.Add("X-LLM-Lab", "1");
    }

    [TearDown]
    public void Stop()
    {
        _client.Dispose();
        _app.Dispose();
        Directory.Delete(_folder, recursive: true);
    }

    [Test]
    public async Task A_request_without_the_lab_header_is_refused()
    {
        using var stranger = _app.CreateClient();
        var response = await stranger.GetAsync("/api/medassist/info");

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Error(response)).GetProperty("type").GetString().Should().Be("forbidden");
    }

    [Test]
    public async Task A_request_from_another_website_is_refused()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/medassist/info");
        request.Headers.Add("Origin", "https://evil.example");

        (await _client.SendAsync(request)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Test]
    public async Task Info_is_in_the_shape_the_page_reads()
    {
        var info = await Json(await _client.GetAsync("/api/medassist/info"));

        info.GetProperty("ready").GetBoolean().Should().BeTrue();
        info.GetProperty("real_texts").GetBoolean().Should().BeFalse();
        info.GetProperty("agent").GetString().Should().Be("MedAssist");
        info.GetProperty("version").GetString().Should().Be("7");
        var andrei = info.GetProperty("patients").EnumerateArray().Single(p => p.GetProperty("id").GetString() == "P007");
        andrei.GetProperty("age").GetInt32().Should().Be(68);
        andrei.GetProperty("language").GetString().Should().Be("Romanian");
    }

    [Test]
    public async Task A_conversation_starts_answers_and_shows_what_changed()
    {
        _engine.Reply = (session, text) =>
        {
            var record = session.GetMyRecord();
            return new TurnResult($"Your GP is {record.RegisteredGp}.",
                                  [new FileSearchStep(["gp"]), new FunctionStep("get_my_record", "{}", record)], new TokenUsage(1000, 0, 100));
        };

        var started = await Json(await _client.PostAsJsonAsync("/api/medassist/chats", new { patient_id = "P002" }));
        started.GetProperty("state").GetProperty("patient").GetProperty("date_of_birth").GetString().Should().Be("1980-03-03");
        var chatId = started.GetProperty("chat_id").GetString();

        var reply = await Json(await _client.PostAsJsonAsync($"/api/medassist/chats/{chatId}/messages", new { message = "Who is my GP?" }));

        reply.GetProperty("reply").GetString().Should().Be("Your GP is Dr Tom Okafor.");
        var steps = reply.GetProperty("steps").EnumerateArray().ToList();
        steps[0].GetProperty("tool").GetString().Should().Be("file_search");
        steps[0].GetProperty("queries")[0].GetString().Should().Be("gp");
        steps[1].GetProperty("result").GetProperty("mobile").GetString().Should().Be("ending 456");
        steps[1].TryGetProperty("code", out _).Should().BeFalse("optional fields are left out, not sent as null");
        reply.GetProperty("state").GetProperty("audit")[0].GetProperty("action").GetString().Should().Be("record viewed");
        reply.TryGetProperty("cost_usd", out _).Should().BeTrue();
    }

    [Test]
    public async Task A_missing_patient_id_is_an_invalid_request_in_the_usual_error_shape()
    {
        var response = await _client.PostAsJsonAsync("/api/medassist/chats", new { });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await Error(response)).GetProperty("type").GetString().Should().Be("invalid_request");
    }

    [Test]
    public async Task An_unknown_patient_is_an_invalid_request_that_lists_the_patients()
    {
        var response = await _client.PostAsJsonAsync("/api/medassist/chats", new { patient_id = "P999" });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await Error(response)).GetProperty("message").GetString().Should().Contain("choose one of P001");
    }

    [Test]
    public async Task A_message_to_an_ended_conversation_is_not_found()
    {
        var response = await _client.PostAsJsonAsync("/api/medassist/chats/nope/messages", new { message = "hello" });

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await Error(response)).GetProperty("message").GetString().Should().Be("That conversation has ended. Start a new one.");
    }

    [Test]
    public async Task A_patients_records_and_a_reset()
    {
        await Json(await _client.PostAsJsonAsync("/api/medassist/chats", new { patient_id = "P001" }));  // makes the database
        var reset = await Json(await _client.PostAsync("/api/medassist/reset", null));
        reset.GetProperty("weeks").GetInt32().Should().Be(PracticeData.WeeksAhead);
        reset.GetProperty("kept_copy").GetString().Should().StartWith(_folder, "the tests never touch the lab's real database");

        var state = await Json(await _client.GetAsync("/api/medassist/patients/P001"));
        state.GetProperty("upcoming")[0].GetProperty("reason").GetString().Should().Be("Annual asthma review");
        state.GetProperty("calls").GetArrayLength().Should().Be(0);
    }

    [Test]
    public async Task The_phone_line_says_it_runs_in_the_python_backend()
    {
        var phone = await Json(await _client.GetAsync("/api/medassist/phone"));

        phone.GetProperty("configured").GetBoolean().Should().BeFalse();
        phone.GetProperty("patient").GetString().Should().Be("P002");
    }

    [Test]
    public async Task Opened_in_a_browser_the_api_says_where_the_page_is()
    {
        using var browser = _app.CreateClient();  // no lab header: a person typing the address
        var html = await browser.GetStringAsync("/");

        html.Should().Contain("localhost:5173/medassist").And.Contain("LLM_LAB_MEDASSIST_API");
    }

    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task<JsonElement> Error(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error");
}
