use std::path::PathBuf;

use eframe::egui;

pub struct EditorPanel {
    pub content: String,
    pub file_path: Option<PathBuf>,
    pub show_url_fetch: bool,
    url_input: String,
    fetch_status: Option<String>,
}

impl EditorPanel {
    pub fn new() -> Self {
        Self {
            content: String::from("# Welcome to markupsidedown\n\nStart typing your Markdown here…\n"),
            file_path: None,
            show_url_fetch: false,
            url_input: String::new(),
            fetch_status: None,
        }
    }

    pub fn show(&mut self, ui: &mut egui::Ui) {
        ui.heading("Editor");
        ui.separator();

        // URL fetch dialog
        if self.show_url_fetch {
            self.show_url_fetch_dialog(ui);
        }

        // Main text editor
        egui::ScrollArea::vertical()
            .id_salt("editor_scroll")
            .show(ui, |ui| {
                ui.add(
                    egui::TextEdit::multiline(&mut self.content)
                        .desired_width(f32::INFINITY)
                        .desired_rows(30)
                        .font(egui::TextStyle::Monospace)
                        .code_editor(),
                );
            });
    }

    fn show_url_fetch_dialog(&mut self, ui: &mut egui::Ui) {
        egui::Frame::group(ui.style()).show(ui, |ui| {
            ui.label("Fetch URL as Markdown (Cloudflare Markdown for Agents)");
            ui.horizontal(|ui| {
                ui.label("URL:");
                ui.text_edit_singleline(&mut self.url_input);
                if ui.button("Fetch").clicked() && !self.url_input.is_empty() {
                    let url = self.url_input.clone();
                    match fetch_url_blocking(&url) {
                        Ok(md) => {
                            self.content = md;
                            self.fetch_status = Some("Fetched successfully".into());
                            self.show_url_fetch = false;
                        }
                        Err(e) => {
                            self.fetch_status = Some(format!("Error: {e}"));
                        }
                    }
                }
                if ui.button("Cancel").clicked() {
                    self.show_url_fetch = false;
                }
            });
            if let Some(status) = &self.fetch_status {
                ui.label(status.as_str());
            }
        });
        ui.add_space(4.0);
    }

    pub fn open_file(&mut self) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("Markdown", &["md", "markdown", "mdx"])
            .add_filter("All files", &["*"])
            .pick_file()
        {
            match std::fs::read_to_string(&path) {
                Ok(text) => {
                    self.content = text;
                    self.file_path = Some(path);
                }
                Err(e) => {
                    tracing::error!("Failed to open file: {e}");
                }
            }
        }
    }

    pub fn save_file(&self) {
        if let Some(path) = &self.file_path {
            if let Err(e) = std::fs::write(path, &self.content) {
                tracing::error!("Failed to save file: {e}");
            }
        } else {
            self.save_file_as();
        }
    }

    pub fn save_file_as(&self) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("Markdown", &["md"])
            .save_file()
        {
            if let Err(e) = std::fs::write(&path, &self.content) {
                tracing::error!("Failed to save file: {e}");
            }
        }
    }
}

/// Simple blocking fetch for URL-to-Markdown.
fn fetch_url_blocking(url: &str) -> anyhow::Result<String> {
    let response = reqwest::blocking::Client::new()
        .get(url)
        .header("Accept", "text/markdown")
        .send()?;

    let body = response.text()?;
    Ok(body)
}
