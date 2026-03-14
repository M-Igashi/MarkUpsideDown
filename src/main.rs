mod editor;
mod integrations;
mod preview;

use eframe::egui;

fn main() -> eframe::Result {
    tracing_subscriber::fmt::init();

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1200.0, 800.0])
            .with_title("markupsidedown"),
        ..Default::default()
    };

    eframe::run_native(
        "markupsidedown",
        options,
        Box::new(|cc| Ok(Box::new(app::App::new(cc)))),
    )
}

mod app {
    use eframe::egui;

    use crate::editor::EditorPanel;
    use crate::preview::PreviewPanel;

    pub struct App {
        editor: EditorPanel,
        preview: PreviewPanel,
    }

    impl App {
        pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
            Self {
                editor: EditorPanel::new(),
                preview: PreviewPanel::new(),
            }
        }
    }

    impl eframe::App for App {
        fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
            // Top menu bar
            egui::TopBottomPanel::top("menu_bar").show(ctx, |ui| {
                egui::menu::bar(ui, |ui| {
                    ui.menu_button("File", |ui| {
                        if ui.button("Open…").clicked() {
                            self.editor.open_file();
                            ui.close_menu();
                        }
                        if ui.button("Save").clicked() {
                            self.editor.save_file();
                            ui.close_menu();
                        }
                        if ui.button("Save As…").clicked() {
                            self.editor.save_file_as();
                            ui.close_menu();
                        }
                    });
                    ui.menu_button("Edit", |_ui| {});
                    ui.menu_button("Integrations", |ui| {
                        if ui.button("Fetch URL as Markdown…").clicked() {
                            self.editor.show_url_fetch = true;
                            ui.close_menu();
                        }
                        if ui.button("GitHub…").clicked() {
                            ui.close_menu();
                        }
                    });
                });
            });

            // Status bar
            egui::TopBottomPanel::bottom("status_bar").show(ctx, |ui| {
                ui.horizontal(|ui| {
                    let line_count = self.editor.content.lines().count();
                    let char_count = self.editor.content.len();
                    ui.label(format!("{line_count} lines | {char_count} chars"));

                    if let Some(path) = &self.editor.file_path {
                        ui.separator();
                        ui.label(path.display().to_string());
                    }
                });
            });

            // Split view: editor (left) + preview (right)
            egui::CentralPanel::default().show(ctx, |ui| {
                let available_width = ui.available_width();
                let panel_width = available_width / 2.0 - 4.0;

                ui.horizontal_top(|ui| {
                    ui.vertical(|ui| {
                        ui.set_width(panel_width);
                        self.editor.show(ui);
                    });

                    ui.separator();

                    ui.vertical(|ui| {
                        ui.set_width(panel_width);
                        self.preview.show(ui, &self.editor.content);
                    });
                });
            });
        }
    }
}
