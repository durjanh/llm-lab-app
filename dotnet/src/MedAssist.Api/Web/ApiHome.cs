namespace MedAssist.Api.Web;

/// <summary>What the API shows when it is opened in a browser: what it is, and where the page that uses it is.</summary>
public static class ApiHome
{
    public const string Html = """
        <!doctype html>
        <html lang="en-GB">
        <head><meta charset="utf-8"><title>MedAssist API</title>
        <style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}code{background:#eee;padding:0 .3em}</style></head>
        <body>
        <h1>MedAssist API (.NET)</h1>
        <p>This is the API only. The page that uses it is the lab's MedAssist page, served by Vite:
        <a href="http://localhost:5173/medassist">http://localhost:5173/medassist</a>.</p>
        <p>Start Vite so it sends MedAssist's calls here:</p>
        <p><code>cd frontend &amp;&amp; LLM_LAB_MEDASSIST_API=http://127.0.0.1:5080 npm run dev</code></p>
        <p>The routes are under <code>/api/medassist</code> and need the lab's <code>X-LLM-Lab: 1</code> header.</p>
        </body>
        </html>
        """;
}
