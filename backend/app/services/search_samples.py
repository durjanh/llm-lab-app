"""The search lab's corpus and labelled queries: an invented home insurance policy wording, plus the claim's files.

The policy is plain text. The claim's files (invoice, claim form, photos, video, narration) come from the Content
Understanding lab and go through Content Understanding on the way in, so one index holds text from every modality.
Each query names the source that should come first, so keyword, vector, hybrid and semantic search can be scored.
"""
from __future__ import annotations

POLICY = [
    ("policy-escape", "Escape of water", "We cover sudden and accidental damage to your home caused by water escaping from "
     "a fixed water or heating installation, a washing machine, dishwasher, fridge or freezer, or a water bed. This includes "
     "leaks from a neighbouring property that enter your home. The excess for escape of water claims is £350."),
    ("policy-trace", "Trace and access", "If water escapes, we pay the reasonable costs of finding where it is coming from, "
     "including removing and replacing any part of the building, up to £5,000 per claim. You do not need to pay a separate "
     "excess for this cover."),
    ("policy-exclusions", "What is not covered", "We do not cover damage caused by water that escapes gradually over time, "
     "such as a slow drip, rot or mould that you knew about or should have noticed; damage while your home is unoccupied "
     "for more than 60 days in a row; or the cost of repairing the appliance or pipe the water came from."),
    ("policy-claims", "Making a claim", "Tell us about a claim as soon as you can, and within 30 days of the damage. Send "
     "photos, invoices or quotes, and keep any damaged items until we have seen them. Turn off the water and electricity "
     "if it is safe to do so."),
    ("policy-accommodation", "Alternative accommodation", "If your home cannot be lived in after insured damage, we pay for "
     "reasonable hotel or rented accommodation for you and your pets, up to £20,000 or 12 months, whichever comes first."),
    ("policy-accidental", "Accidental damage", "Accidental damage cover is optional. It pays for sudden, unexpected damage, "
     "such as spilling paint on a carpet or putting a foot through a ceiling while in the loft. The excess is £100."),
    ("policy-decoration", "Redecoration", "After an insured loss we pay to redecorate the damaged area of the room, matching "
     "the existing finish where we can. If we cannot match it, we pay to redecorate the whole wall or ceiling."),
    ("policy-cancel", "Cancelling your policy", "You can cancel within 14 days of starting or renewing your policy and get a "
     "full refund, as long as you have not made a claim. After that, we refund the premium for the days left, less £25."),
]

QUERIES = [  # (question, the source that should be found first)
    ("My washing machine flooded the kitchen. Am I covered?", "policy-escape"),
    ("What excess do I pay for water damage?", "policy-escape"),
    ("Will you pay to find where the leak is coming from?", "policy-trace"),
    ("The pipe had been dripping slowly for months. Can I still claim?", "policy-exclusions"),
    ("How long do I have to report the damage?", "policy-claims"),
    ("What is invoice KD-20419 for?", "doc-invoice"),
    ("Who is the policyholder on claim HM-HOME-558120?", "doc-claim"),
    ("Is there a photo of the stain on the ceiling?", "photo-ceiling"),
    ("What did the narrator say about the plumber's van?", "media-video"),
    ("Can I stay in a hotel while the kitchen is repaired?", "policy-accommodation"),
    ("Will you repaint the whole ceiling if the colour can't be matched?", "policy-decoration"),
    ("How much were two boxes of cereal?", "photo-shelf"),
]

# The built-in skillset an indexer would run for the same pipeline, for comparison with the push pipeline here.
SKILLSET = {
    "name": "claims-skillset",
    "skills": [
        {"@odata.type": "#Microsoft.Skills.Util.ContentUnderstandingSkill", "context": "/document",
         "description": "OCR, layout and Markdown for documents and images (or OcrSkill plus DocumentLayoutSkill)",
         "outputs": [{"name": "text_sections", "targetName": "sections"}]},
        {"@odata.type": "#Microsoft.Skills.Text.SplitSkill", "context": "/document", "textSplitMode": "pages",
         "maximumPageLength": 900, "pageOverlapLength": 100,
         "inputs": [{"name": "text", "source": "/document/content"}], "outputs": [{"name": "textItems", "targetName": "chunks"}]},
        {"@odata.type": "#Microsoft.Skills.Text.KeyPhraseExtractionSkill", "context": "/document/chunks/*",
         "inputs": [{"name": "text", "source": "/document/chunks/*"}], "outputs": [{"name": "keyPhrases", "targetName": "keyPhrases"}]},
        {"@odata.type": "#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill", "context": "/document/chunks/*",
         "resourceUri": "https://<resource>.openai.azure.com", "deploymentId": "text-embedding-3-small", "modelName": "text-embedding-3-small",
         "inputs": [{"name": "text", "source": "/document/chunks/*"}], "outputs": [{"name": "embedding", "targetName": "vector"}]},
        {"@odata.type": "#Microsoft.Skills.Custom.WebApiSkill", "context": "/document",
         "description": "A custom skill: your own HTTPS endpoint, called once per document (for example, to look up the policy)",
         "uri": "https://<your-function>.azurewebsites.net/api/enrich", "inputs": [{"name": "text", "source": "/document/content"}],
         "outputs": [{"name": "policyNumber", "targetName": "policyNumber"}]},
    ],
    "indexProjections": {"selectors": [{"targetIndexName": "lab-claims", "parentKeyFieldName": "parent_id",
                                        "sourceContext": "/document/chunks/*",
                                        "mappings": [{"name": "chunk", "source": "/document/chunks/*"},
                                                     {"name": "contentVector", "source": "/document/chunks/*/vector"}]}]},
}
