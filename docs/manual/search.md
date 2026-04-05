# Semantic Search

Semantic search lets you find documents by meaning rather than exact keywords. It uses vector embeddings powered by Cloudflare Vectorize to understand the intent behind your query.

## Requirements

Semantic search requires the **VECTORS** Vectorize binding in your Cloudflare Worker. This is set up during the Cloudflare Worker setup (see [Installation & Setup](installation.md)). Check **Settings → Feature Status** to confirm "Semantic Search" shows a green checkmark.

## Indexing Documents

Documents are indexed automatically when they are imported or crawled. You can also manually index documents through the MCP server's embed tool.

Indexing converts your document content into vector embeddings and stores them in Cloudflare Vectorize. This enables similarity-based retrieval.

## Searching

There are two ways to search:

### Dedicated Search Panel (Cmd+5)

Press **Cmd+5** to open the semantic search panel. Type your query and results appear with relevance scores.

![Search panel with relevance scores](images/search/search-panel.png)

### Command Palette (? prefix)

Open the command palette (Cmd+K) and type `?` followed by your query. Results show document matches with relevance percentages instead of commands.

![Search results in command palette](images/search/search-results.png)

## Working with Results

- Results are ranked by relevance (shown as a percentage)
- Use Arrow Up/Down to navigate results
- Press Enter to open the selected document
- Press Escape to close the search

## Removing Documents from the Index

Documents can be removed from the Vectorize index through the MCP server's delete embed tool, or by calling the Worker's `DELETE /embed/:id` endpoint directly.
