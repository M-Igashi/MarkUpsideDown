use eframe::egui;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

pub struct PreviewPanel;

impl PreviewPanel {
    pub fn new() -> Self {
        Self
    }

    pub fn show(&self, ui: &mut egui::Ui, markdown_source: &str) {
        ui.heading("Preview");
        ui.separator();

        egui::ScrollArea::vertical()
            .id_salt("preview_scroll")
            .show(ui, |ui| {
                render_markdown(ui, markdown_source);
            });
    }
}

fn render_markdown(ui: &mut egui::Ui, source: &str) {
    let options = Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(source, options);

    let mut in_code_block = false;
    let mut code_buf = String::new();
    let mut current_heading: Option<HeadingLevel> = None;
    let mut in_list = false;

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                current_heading = Some(level);
            }
            Event::End(TagEnd::Heading(_)) => {
                current_heading = None;
            }
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                code_buf.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                egui::Frame::group(ui.style()).show(ui, |ui| {
                    ui.monospace(&code_buf);
                });
                code_buf.clear();
            }
            Event::Start(Tag::List(_)) => {
                in_list = true;
            }
            Event::End(TagEnd::List(_)) => {
                in_list = false;
            }
            Event::Start(Tag::Paragraph) | Event::End(TagEnd::Paragraph) => {}
            Event::Text(text) => {
                if in_code_block {
                    code_buf.push_str(&text);
                } else if let Some(level) = current_heading {
                    let size = match level {
                        HeadingLevel::H1 => 28.0,
                        HeadingLevel::H2 => 24.0,
                        HeadingLevel::H3 => 20.0,
                        _ => 16.0,
                    };
                    ui.label(
                        egui::RichText::new(text.as_ref())
                            .size(size)
                            .strong(),
                    );
                } else if in_list {
                    ui.horizontal(|ui| {
                        ui.label("  •");
                        ui.label(text.as_ref());
                    });
                } else {
                    ui.label(text.as_ref());
                }
            }
            Event::Code(code) => {
                ui.monospace(code.as_ref());
            }
            Event::SoftBreak | Event::HardBreak => {
                ui.label("");
            }
            Event::Rule => {
                ui.separator();
            }
            _ => {}
        }
    }
}
