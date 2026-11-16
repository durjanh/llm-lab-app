# Filesystem MCP server

`@modelcontextprotocol/server-filesystem` is the MCP project's own reference server for files. It is still maintained (npm 2.3.0, pinned). It only reaches the folders named on its command line.

**How it does the task.** `run.py` writes the 12 handbook sections as `<slug>.md` files into a temp folder (resolved with `Path.resolve()`, because macOS temp folders are symlinks and the server compares real paths), starts the server with `npx -y @modelcontextprotocol/server-filesystem@2.3.0 <folder>`, and asks the first three gold questions. Claude lists the folder, then reads the right file. The folder is deleted at the end.

**Read-only.** The server has 16 tools; 9 are on the allow-list (`read_text_file`, `read_file`, `read_multiple_files`, `list_directory`, `list_directory_with_sizes`, `directory_tree`, `search_files`, `get_file_info`, `list_allowed_directories`). Write, edit, move and create-directory tools are not offered.

**Limits.** The model must find the file itself: with 12 files that is cheap, but a big tree would need `search_files` and more turns.

Ran on 2026-11-15: PASS, 3/3 answers correct (about 2 tool calls per question).
