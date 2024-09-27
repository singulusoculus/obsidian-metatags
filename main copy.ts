import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	MarkdownView,
	TAbstractFile,
} from "obsidian";
import * as YAML from "yaml";
import debounce from "lodash.debounce";

interface MetaTagsSettings {
	tagBase: string;
}

const DEFAULT_SETTINGS: MetaTagsSettings = {
	tagBase: "mt",
};

export default class MetaTagsPlugin extends Plugin {
	settings: MetaTagsSettings;
	private suppressChange: boolean = false;
	private suppressAddition: boolean = false;
	private suppressRemoval: boolean = false;
	private suppressTemplateChange: boolean = false;
	private recentFiles: Set<string> = new Set();
	private previousTemplateState: { [key: string]: any } = {};
	private templatePropertyMap: { [templateName: string]: string[] } = {};

	async onload() {
		console.log("Loading MetaTags plugin");

		// Load settings
		await this.loadSettings();

		// Wait for the vault to be fully loaded before initializing template states
		this.app.workspace.onLayoutReady(() => {
			this.initializeTemplateStates().then(() => {
				console.log(
					"Template states initialized:",
					this.previousTemplateState
				);
			});
		});

		// Add settings tab
		this.addSettingTab(new MetaTagsSettingTab(this.app, this));

		// Register event listener for tag changes
		this.registerEvent(
			this.app.metadataCache.on(
				"changed",
				debounce((file: TFile) => {
					if (this.suppressChange) return; // Skip if we are modifying the note
					if (this.recentFiles.has(file.path)) return; // Skip if the file was recently processed

					console.log("Event registered for:", file.path);

					// Temporarily add the file to recentFiles to avoid reprocessing
					this.recentFiles.add(file.path);
					setTimeout(() => this.recentFiles.delete(file.path), 2000); // Remove after 2 seconds

					this.handleTagChange(file);
				}, 500)
			)
		);

		this.registerEvent(
			this.app.vault.on("modify", async (file: TFile) => {
				if (file.extension !== "md") return; // Only check markdown files

				const metadata = this.app.metadataCache.getFileCache(file);
				if (
					metadata?.frontmatter &&
					this.hasTagBase(metadata.frontmatter.tags)
				) {
					console.log(this.previousTemplateState);
					await this.syncNotesWithTemplate(file.basename);
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on("file-open", async (file: TFile) => {
				if (file && file.extension === "md") {
					await this.applyMetaTagAttributes(file);
				}
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", async (file) => {
				if (file && file.extension === "md") {
					await this.updateMetaTagAttributes(file);
					await this.removeEmptyTemplateProperties(file);
				}
			})
		);

		console.log("MetaTags plugin loaded");
	}

	async removeEmptyTemplateProperties(file: TFile) {
		if (this.suppressChange) return;

		this.suppressChange = true; // Set suppression flag

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.suppressChange = false;
			return;
		}

		let existingContent = await this.app.vault.read(file);
		let existingFrontmatter = this.extractFrontmatter(existingContent);
		let hasChanges = false;

		const elements = view.containerEl.querySelectorAll(
			'.metadata-property-key[data-metatag="true"]'
		);

		elements.forEach((el) => {
			const inputElement = el.querySelector(
				".metadata-property-key-input"
			);
			const propertyName = inputElement
				?.getAttribute("aria-label")
				?.trim();

			if (
				propertyName &&
				existingFrontmatter.hasOwnProperty(propertyName) &&
				this.isEmpty(existingFrontmatter[propertyName])
			) {
				console.log(
					`Removing empty property ${propertyName} from note ${file.path}`
				);
				delete existingFrontmatter[propertyName];
				hasChanges = true;
			}
		});

		if (hasChanges) {
			const updatedContent = this.updateContentWithFrontmatter(
				existingContent,
				existingFrontmatter
			);
			await this.app.vault.modify(file, updatedContent);
		}

		this.suppressChange = false; // Reset suppression flag
	}

	async updateMetaTagAttributes(file: TAbstractFile) {
		if (this.suppressChange) return; // Prevent re-entrance
		if (!(file instanceof TFile)) return; // Check if file is a TFile

		const metadata = this.app.metadataCache.getFileCache(file);
		const tags = metadata?.frontmatter?.tags;

		if (!tags) return;

		const metaTag = tags.find((tag: any) =>
			tag.startsWith(`${this.settings.tagBase}/`)
		);
		const templateName = metaTag?.split("/")[1];
		const templateFile = this.app.vault.getAbstractFileByPath(
			`${templateName}.md`
		);

		if (templateFile && metaTag && templateFile instanceof TFile) {
			// Check if templateFile is a TFile
			const templateContent = await this.app.vault.read(templateFile);
			const templateProperties = this.extractFrontmatter(templateContent);
			this.addMetaTagAttributesToProperties(file, templateProperties);
		} else {
			this.removeMetaTagAttributesFromProperties(file);
		}
	}

	// Apply data-metatag="true" to template properties
	async addMetaTagAttributesToProperties(
		file: TFile,
		templateProperties: any
	) {
		if (this.suppressAddition) return; // Prevent loop on addition

		this.suppressAddition = true; // Set suppression flag

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.suppressAddition = false;
			return;
		}

		// 1. Update the templatePropertyMap with the template properties.
		const templateName = Object.keys(templateProperties).find((key) =>
			key.startsWith(this.settings.tagBase)
		);
		if (templateName) {
			this.templatePropertyMap[templateName] =
				Object.keys(templateProperties);
		}

		// 2. Update the note's frontmatter with template properties if not already present.
		let existingContent = await this.app.vault.read(file);
		let existingFrontmatter = this.extractFrontmatter(existingContent);

		// Add properties from the template to the note if they don't already exist.
		for (const [key, value] of Object.entries(templateProperties)) {
			if (!existingFrontmatter.hasOwnProperty(key)) {
				existingFrontmatter[key] = value;
			}
		}

		// 3. Apply the `data-metatag="true"` attribute to the corresponding properties in the HTML view.
		const elements = view.containerEl.querySelectorAll(
			".metadata-property-key"
		);
		elements.forEach((el) => {
			const inputElement = el.querySelector(
				".metadata-property-key-input"
			);
			const propertyName = inputElement
				?.getAttribute("aria-label")
				?.trim();
			if (
				propertyName &&
				templateProperties.hasOwnProperty(propertyName)
			) {
				el.setAttribute("data-metatag", "true"); // Apply attribute to the HTML element
			}
		});

		// 4. Update the note's frontmatter with the merged properties.
		const updatedContent = this.updateContentWithFrontmatter(
			existingContent,
			existingFrontmatter
		);
		await this.app.vault.modify(file, updatedContent);
		this.suppressAddition = false;
	}

	// Remove or set data-metatag="false" for all properties
	removeMetaTagAttributesFromProperties(file: TFile) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const elements = view.containerEl.querySelectorAll(
			'.metadata-property-key[data-metatag="true"]'
		);
		elements.forEach((el) => {
			el.removeAttribute("data-metatag"); // Remove attribute
			// Optionally set to false:
			// el.setAttribute('data-metatag', 'false');
		});
	}

	async applyMetaTagAttributes(file: TFile) {
		const metadata = this.app.metadataCache.getFileCache(file);
		const tags = metadata?.frontmatter?.tags;
		if (!tags) return;

		const metaTag = tags.find((tag: any) =>
			tag.startsWith(`${this.settings.tagBase}/`)
		);
		if (!metaTag) return;

		// Extract the template name from the tag
		const templateName = metaTag.split("/")[1];
		const templateFile = this.app.vault.getAbstractFileByPath(
			`${templateName}.md`
		);
		if (!templateFile || !(templateFile instanceof TFile)) return;

		// Get properties from the template
		const templateContent = await this.app.vault.read(templateFile);
		const templateProperties = this.extractFrontmatter(templateContent);

		// Apply attributes to properties in the note
		this.addMetaTagAttributesToProperties(file, templateProperties);
	}

	// Helper method to initialize template states
	async initializeTemplateStates() {
		const allFiles = this.app.vault.getMarkdownFiles();

		for (const file of allFiles) {
			const metadata = this.app.metadataCache.getFileCache(file);
			if (metadata?.frontmatter?.tags?.includes(this.settings.tagBase)) {
				const templateContent = await this.app.vault.read(file);
				this.previousTemplateState[file.basename] =
					this.extractFrontmatter(templateContent);
			}
		}
	}

	async initializeTemplateProperties() {
		const allFiles = this.app.vault.getMarkdownFiles();
		for (const file of allFiles) {
			const metadata = this.app.metadataCache.getFileCache(file);
			if (metadata?.frontmatter?.tags?.includes(this.settings.tagBase)) {
				const templateContent = await this.app.vault.read(file);
				const templateFrontmatter =
					this.extractFrontmatter(templateContent);
				this.templatePropertyMap[file.basename] =
					Object.keys(templateFrontmatter);
			}
		}
	}

	getDeletedProperties(oldTemplate: any, newTemplate: any): string[] {
		const deletedProperties: string[] = [];
		for (const key in oldTemplate) {
			if (!Object.prototype.hasOwnProperty.call(newTemplate, key)) {
				console.log(`Property deleted from template: ${key}`); // Debug
				deletedProperties.push(key);
			}
		}
		return deletedProperties;
	}

	// Helper method to check if a file contains the tagBase tag
	hasTagBase(tags: any): boolean {
		if (!tags) return false;

		// Check if the tags include the base tag (e.g., mt)
		return Array.isArray(tags) && tags.includes(this.settings.tagBase);
	}

	handleTagChange(file: TFile) {
		if (this.suppressChange) return; // Skip processing if we are updating the note ourselves

		const metadata = this.app.metadataCache.getFileCache(file);
		if (metadata?.frontmatter && metadata.frontmatter["tags"]) {
			const tags = metadata.frontmatter["tags"];

			if (Array.isArray(tags)) {
				const matchingTags = tags.filter((tag) =>
					tag.startsWith(`${this.settings.tagBase}/`)
				);

				matchingTags.forEach((tag) => {
					const templateName = tag.split("/")[1];
					this.applyMetadataTemplate(file, templateName);
				});
			}
		}
	}

	async applyMetadataTemplate(file: TFile, templateName: string) {
		if (this.suppressChange) return; // Early return if we're already in a suppression state

		const templateFile = this.app.vault.getAbstractFileByPath(
			templateName + ".md"
		);
		if (templateFile instanceof TFile) {
			const templateContent = await this.app.vault.read(templateFile);
			const templateFrontmatter =
				this.extractFrontmatter(templateContent);

			if (templateFrontmatter) {
				const existingContent = await this.app.vault.read(file);
				const existingFrontmatter =
					this.extractFrontmatter(existingContent);

				// Check if there's any difference between existing and template frontmatter
				const mergedFrontmatter = this.mergeFrontmatter(
					existingFrontmatter,
					templateFrontmatter
				);
				if (
					JSON.stringify(existingFrontmatter) ===
					JSON.stringify(mergedFrontmatter)
				) {
					return; // Skip update if frontmatter is identical
				}

				const updatedContent = this.updateContentWithFrontmatter(
					existingContent,
					mergedFrontmatter
				);

				this.suppressChange = true; // Set suppression flag
				try {
					await this.app.vault.modify(file, updatedContent);
				} finally {
					this.suppressChange = false; // Reset suppression flag, using `finally` ensures it resets even if an error occurs
				}
			}
		}
	}

	extractFrontmatter(content: string): any {
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (match) {
			try {
				return YAML.parse(match[1]);
			} catch (e) {
				console.error("Failed to parse frontmatter", e);
				return {};
			}
		}
		return {};
	}

	mergeFrontmatter(existing: any, template: any): any {
		// Clone existing and template to avoid mutating original objects
		const merged = { ...template, ...existing };

		// Remove tagBase from the merged tags property if it exists
		if (Array.isArray(merged.tags)) {
			merged.tags = merged.tags.filter(
				(tag: any) => tag !== this.settings.tagBase
			);
		}

		return merged;
	}

	updateContentWithFrontmatter(content: string, frontmatter: any): string {
		const frontmatterString = `---\n${YAML.stringify(frontmatter)}---\n`;

		// Get the body without frontmatter, trimming unnecessary new lines
		const existingBody =
			content
				.split(/^---\n[\s\S]*?\n---/)
				.pop()
				?.trim() || "";

		// Combine frontmatter and body with a single new line in between
		return `${frontmatterString}\n${existingBody}`;
	}

	async addFrontmatterToFile(file: TFile, frontmatter: string) {
		let content = await this.app.vault.read(file);
		const match = content.match(/^---\n[\s\S]*?\n---/);
		if (match) {
			content = content.replace(match[0], `---\n${frontmatter}\n---`);
		} else {
			content = `---\n${frontmatter}\n---\n\n` + content;
		}
		await this.app.vault.modify(file, content);
	}

	async syncNotesWithTemplate(templateName: string) {
		const templateFile = this.app.vault.getAbstractFileByPath(
			`${templateName}.md`
		);
		if (!(templateFile instanceof TFile)) return;

		// Use stored state for comparison
		const previousFrontmatter =
			this.previousTemplateState[templateName] || {};

		const newTemplateContent = await this.app.vault.read(templateFile);
		const newTemplateFrontmatter =
			this.extractFrontmatter(newTemplateContent);
		if (!newTemplateFrontmatter) return;

		const deletedProperties = this.getDeletedProperties(
			previousFrontmatter,
			newTemplateFrontmatter
		);

		if (deletedProperties.length > 0) {
			const confirmMessage = `The following properties will be removed from all notes with the MetaTag "${templateName}":\n${deletedProperties.join(
				", "
			)}\n\nDo you want to proceed?`;
			if (!window.confirm(confirmMessage)) {
				console.log(
					"User canceled the deletion of properties from notes."
				);

				// Suppress template change event and restore previous content
				this.suppressTemplateChange = true;
				const revertedContent = `---\n${YAML.stringify(
					previousFrontmatter
				)}---\n${newTemplateContent
					.split(/^---\n[\s\S]*?\n---/)
					.pop()}`;
				await this.app.vault.modify(templateFile, revertedContent);
				this.suppressTemplateChange = false;

				return;
			}
		}

		this.previousTemplateState[templateName] = newTemplateFrontmatter;

		// Check each note with the MetaTag
		const allFiles = this.app.vault.getMarkdownFiles();
		for (const file of allFiles) {
			const metadata = this.app.metadataCache.getFileCache(file);
			if (
				metadata?.frontmatter?.tags?.includes(
					`${this.settings.tagBase}/${templateName}`
				)
			) {
				let existingContent = await this.app.vault.read(file);
				let existingFrontmatter =
					this.extractFrontmatter(existingContent);

				// Remove only properties with no content
				deletedProperties.forEach((prop) => {
					if (
						existingFrontmatter.hasOwnProperty(prop) &&
						!existingFrontmatter[prop]
					) {
						console.log(
							`Removing empty property ${prop} from note ${file.path}`
						);
						delete existingFrontmatter[prop];
					}
				});

				const mergedFrontmatter = this.mergeFrontmatter(
					existingFrontmatter,
					newTemplateFrontmatter
				);

				if (
					JSON.stringify(existingFrontmatter) !==
					JSON.stringify(mergedFrontmatter)
				) {
					const updatedContent = this.updateContentWithFrontmatter(
						existingContent,
						mergedFrontmatter
					);
					this.suppressChange = true;
					await this.app.vault.modify(file, updatedContent);
					this.suppressChange = false;
				}
			}
		}
	}

	isEmpty(value: any): boolean {
		return value === undefined || value === null || value === "";
	}

	onunload() {
		console.log("Unloading MetaTags plugin");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class MetaTagsSettingTab extends PluginSettingTab {
	plugin: MetaTagsPlugin;

	constructor(app: App, plugin: MetaTagsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "MetaTags Plugin Settings" });

		new Setting(containerEl)
			.setName("Tag Base")
			.setDesc("Base tag for all MetaTags. Default is 'mt'.")
			.addText((text) =>
				text
					.setPlaceholder("mt")
					.setValue(this.plugin.settings.tagBase)
					.onChange(async (value) => {
						this.plugin.settings.tagBase = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
