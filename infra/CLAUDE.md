# infra/

`azd up` (`azure.yaml`, `infra/`) provisions all the lab's Azure resources, the sandbox included, and writes `.env` through `infra/hooks/write_env.py` (everything but `LLM_LAB_SANDBOX`, which stays the person's choice); `azd down --purge` removes them. `.github/workflows/infra.yml` runs `azd provision` and `examples/foundry-cicd/eval_gate.py` on main, as the identity `infra/pipeline.sh` makes; in the pipeline the hooks skip Entra and `.env`, and the person's id is `LAB_PRINCIPAL_ID` (azd sets `AZURE_PRINCIPAL_ID` to whoever is signed in).
