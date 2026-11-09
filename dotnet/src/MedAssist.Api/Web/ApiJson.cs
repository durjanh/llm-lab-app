using System.Text.Json;
using System.Text.Json.Serialization;
using MedAssist.Api.Contracts;
using Microsoft.AspNetCore.Mvc;

namespace MedAssist.Api.Web;

/// <summary>The API's JSON: snake_case names, and optional fields left out rather than sent as null.</summary>
public static class ApiJson
{
    public static readonly JsonSerializerOptions Options = Configure(new JsonSerializerOptions(JsonSerializerDefaults.Web));

    public static JsonSerializerOptions Configure(JsonSerializerOptions options)
    {
        options.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
        options.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        return options;
    }

    /// <summary>A request the model binder rejects (a missing patient_id, say), in the same error shape as the rest.</summary>
    public static IActionResult InvalidRequest(ActionContext context)
    {
        var problems = context.ModelState.Where(e => e.Value?.Errors.Count > 0)
                              .Select(e => $"{JsonNamingPolicy.SnakeCaseLower.ConvertName(e.Key.TrimStart('$', '.'))}: " +
                                           string.Join(" ", e.Value!.Errors.Select(x => x.ErrorMessage)));
        return new BadRequestObjectResult(new ErrorResponse(new ErrorBody("invalid_request", string.Join("; ", problems))));
    }
}
