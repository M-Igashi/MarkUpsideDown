# Presentation Mode

MarkUpsideDown can turn any Markdown document into a fullscreen slide presentation. Slides are split at horizontal rules (`---`), so you can write a presentation using the same Markdown you already know.

## Starting a Presentation

Open the Command Palette (Cmd+K) and run **Presentation Mode**. The app enters fullscreen and displays the first slide.

![Presentation mode showing a slide](images/presentation/presentation-slide.png)

The first slide displays the document's frontmatter (title, author, date, tags) as a title card:

![Presentation title slide with frontmatter](images/presentation/presentation-first-slide.png)

## Writing Slides

Separate slides with a horizontal rule (`---`). Each section between rules becomes one slide:

```markdown
# Welcome to My Talk

An introduction to the topic.

---

## Slide 2

- Point one
- Point two
- Point three

---

## Slide 3

Code works too:

\```python
print("Hello from a slide!")
\```

---

## Thank You

Questions?
```

All standard Markdown features work in slides: headings, lists, code blocks, images, bold/italic, links, and more.

## Navigation

| Action | How |
|--------|-----|
| Next slide | Click right half of screen, Arrow Right, Arrow Down, or Space |
| Previous slide | Click left half of screen, Arrow Left, or Arrow Up |
| First slide | Home |
| Last slide | End |
| Exit presentation | Escape |

A slide counter at the bottom shows your current position (e.g., "3 / 12").

## Tips

- **Keep slides concise.** One idea per slide works best.
- **Use headings.** A heading at the top of each slide provides structure.
- **Images work.** Include images with standard Markdown syntax — they render at their natural size within the slide.
- **Mermaid diagrams** and **KaTeX math** render in slides just as they do in the preview.
- **No separate file format.** Your presentation is just a Markdown file. Edit, preview, and present — all in the same app.
