import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	debounce,
} from "obsidian";
import * as YAML from "js-yaml";

interface MetaTagsSettings {
	tagBase: string;
}

const DEFAULT_SETTINGS: MetaTagsSettings = {
	tagBase: "mt",
};

export default class MetaTagsPlugin extends Plugin {
	settings: MetaTagsSettings;
	fileTagCache: Map<string, string[]> = new Map();
	templateCache: Map<string, any> = new Map();

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new MetaTagsSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.initializeFileTagCache();
			this.initializeTemplateCache();
		});

		// Debounce to prevent rapid successive calls
		const handleMetadataChange = debounce(
			async (file: TFile) => await this.onMetadataChanged(file),
			500,
			true
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				handleMetadataChange(file);
			})
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.applyMetaTagAttributes(file);
				}
			})
		);
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

	/**
	 * Initializes the fileTagCache by scanning all markdown files in the vault
	 * and storing their tags.
	 */
	initializeFileTagCache() {
		const allFiles = this.app.vault.getMarkdownFiles();
		for (const file of allFiles) {
			const tags = this.getAllTags(file);
			this.fileTagCache.set(file.path, tags);
		}
	}

	initializeTemplateCache() {
		const tagBase = this.settings.tagBase;
		const templateFolder = this.app.vault.getAbstractFileByPath(tagBase);

		if (templateFolder && templateFolder instanceof TFolder) {
			const templateFiles = this.getAllTemplateFiles(templateFolder);
			for (const file of templateFiles) {
				const frontmatter =
					this.app.metadataCache.getFileCache(file)?.frontmatter ||
					{};
				this.templateCache.set(file.path, frontmatter);
			}
		}
	}

	getAllTemplateFiles(folder: TFolder): TFile[] {
		let files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === "md") {
				files.push(child);
			} else if (child instanceof TFolder) {
				files = files.concat(this.getAllTemplateFiles(child));
			}
		}
		return files;
	}

	async onMetadataChanged(file: TFile) {
		const isTemplate = await this.isTemplateFile(file);

		if (isTemplate) {
			// Template metadata changed
			console.log("handleTemplateMetadataChange");
			this.handleTemplateMetadataChange(file);
		} else {
			// Note metadata changed
			const currentTags = this.getAllTags(file);
			const prevTags = this.fileTagCache.get(file.path) || [];

			const addedTags = this.getAddedTags(prevTags, currentTags);
			const removedTags = this.getRemovedTags(prevTags, currentTags);

			if (addedTags.length > 0) {
				console.log("handleMetaTagAdded");
				await this.handleMetaTagAdded(file, addedTags);
			}

			if (removedTags.length > 0) {
				console.log("handleMetaTagRemoved");
				await this.handleMetaTagRemoved(file, removedTags);
			}

			// Update the cache with current tags
			this.fileTagCache.set(file.path, currentTags);
		}
	}

	async isTemplateFile(file: TFile): Promise<boolean> {
		const tagBase = this.settings.tagBase;
		const templatesFolder = this.app.vault.getAbstractFileByPath(tagBase);

		// Check if file.parent and templatesFolder are valid
		if (!file.parent || !templatesFolder) {
			return false;
		}

		return file.parent.path === templatesFolder.path;
	}

	getAddedTags(prevTags: string[], currentTags: string[]): string[] {
		return currentTags.filter((tag) => !prevTags.includes(tag));
	}

	getRemovedTags(prevTags: string[], currentTags: string[]): string[] {
		return prevTags.filter((tag) => !currentTags.includes(tag));
	}

	async handleMetaTagAdded(file: TFile, addedTags: string[]) {
		const metaTagNames = addedTags
			.filter((tag) => tag.startsWith(`${this.settings.tagBase}/`))
			.map((tag) => tag.replace(`${this.settings.tagBase}/`, ""));

		if (metaTagNames.length > 0) {
			await this.applyTemplateMetadata(file, metaTagNames);
			this.applyMetaTagAttributes(file);
		}
	}

	async handleMetaTagRemoved(file: TFile, removedTags: string[]) {
		for (const tag of removedTags) {
			if (tag.startsWith(this.settings.tagBase)) {
				const metaTagName = tag.replace(
					`${this.settings.tagBase}/`,
					""
				);
				await this.removeEmptyTemplateProperties(file, metaTagName);
				this.removeMetaTagAttributes(file, metaTagName);
			}
		}
	}

	async handleTemplateMetadataChange(templateFile: TFile) {
		const metaTagName = templateFile.basename;

		// Get previous and current frontmatter
		const prevTemplateData =
			this.templateCache.get(templateFile.path) || {};
		const currTemplateData =
			this.app.metadataCache.getFileCache(templateFile)?.frontmatter ||
			{};

		// Update the templateCache with current frontmatter
		this.templateCache.set(templateFile.path, currTemplateData);

		// Remove 'tags' and 'mt' from consideration
		const ignoreProps = ["tags", "mt"];
		const prevProps = Object.keys(prevTemplateData).filter(
			(prop) => !ignoreProps.includes(prop)
		);
		const currProps = Object.keys(currTemplateData).filter(
			(prop) => !ignoreProps.includes(prop)
		);

		// Determine added and removed properties
		const addedProps = currProps.filter(
			(prop) => !prevProps.includes(prop)
		);
		const removedProps = prevProps.filter(
			(prop) => !currProps.includes(prop)
		);

		// Get all notes with this MetaTag
		const allFiles = this.app.vault.getMarkdownFiles();
		for (const file of allFiles) {
			const tags = this.getAllTags(file);
			if (tags.includes(`${this.settings.tagBase}/${metaTagName}`)) {
				await this.syncTemplateToNote(
					file,
					metaTagName,
					addedProps,
					removedProps,
					currTemplateData
				);
			}
		}
	}

	async applyTemplateMetadata(file: TFile, metaTagNames: string[]) {
		const noteData =
			this.app.metadataCache.getFileCache(file)?.frontmatter || {};
		let mergedTemplateData = {};

		for (const metaTagName of metaTagNames) {
			const tagBase = this.settings.tagBase;
			const templateFilePath = `${tagBase}/${metaTagName}.md`;
			const templateFile = this.app.vault.getAbstractFileByPath(
				templateFilePath
			) as TFile;

			if (!templateFile) continue;

			const templateData =
				this.app.metadataCache.getFileCache(templateFile)
					?.frontmatter || {};
			mergedTemplateData = { ...mergedTemplateData, ...templateData };
		}

		// Remove 'tags' and 'mt' from template data
		// delete mergedTemplateData['tags'];
		// delete mergedTemplateData['mt'];

		// Merge with note data, note data takes precedence
		const mergedData = { ...mergedTemplateData, ...noteData };

		const content = await this.app.vault.read(file);
		const newContent = this.replaceFrontMatter(content, mergedData);

		await this.app.vault.modify(file, newContent);
	}

	async syncTemplateToNote(
		file: TFile,
		metaTagName: string,
		addedProps: string[],
		removedProps: string[],
		currTemplateData: any
	) {
		const noteData =
			this.app.metadataCache.getFileCache(file)?.frontmatter || {};

		// Create a copy of noteData
		const newData = { ...noteData };

		// For added properties
		for (const prop of addedProps) {
			if (!(prop in newData)) {
				// Add the property from the template to the note
				newData[prop] = currTemplateData[prop];
			}
			// If the property already exists in the note, leave it unchanged
		}

		// For removed properties
		for (const prop of removedProps) {
			if (
				prop in newData &&
				(newData[prop] === "" || newData[prop] == null)
			) {
				// Remove the property from the note if it's empty
				delete newData[prop];
			}
			// If the property has a value, leave it unchanged
		}

		// Remove 'tags' and 'mt' from newData if present
		// delete newData['tags'];
		// delete newData['mt'];

		const content = await this.app.vault.read(file);
		const newContent = this.replaceFrontMatter(content, newData);

		await this.app.vault.modify(file, newContent);
	}

	async syncTemplateToNotes(file: TFile, metaTagName: string) {
		const templateFile = this.app.vault.getAbstractFileByPath(
			`${this.settings.tagBase}/${metaTagName}.md`
		) as TFile;
		if (!templateFile) return;

		const templateData =
			this.app.metadataCache.getFileCache(templateFile)?.frontmatter ||
			{};
		const noteData =
			this.app.metadataCache.getFileCache(file)?.frontmatter || {};

		const mergedData = { ...templateData, ...noteData };

		// delete mergedData["tags"];
		// delete mergedData["mt"];

		const content = await this.app.vault.read(file);
		const newContent = this.replaceFrontMatter(content, mergedData);
		console.log(newContent);
		// return;

		await this.app.vault.modify(file, newContent);
	}

	async removeEmptyTemplateProperties(file: TFile, metaTagName: string) {
		return;
		const noteData =
			this.app.metadataCache.getFileCache(file)?.frontmatter || {};

		const content = await this.app.vault.read(file);
		const newData = { ...noteData };

		for (const key in newData) {
			if (newData[key] === "" || newData[key] === null) {
				delete newData[key];
			}
		}

		const newContent = this.replaceFrontMatter(content, newData);
		await this.app.vault.modify(file, newContent);
	}

	applyMetaTagAttributes(file: TFile) {
		// Since we cannot manipulate the editor's HTML directly from the plugin,
		// this function would rely on a markdown post-processor or a custom code mirror mode.
		// For simplicity, we will assume that the CSS targets the data attributes appropriately.
	}

	removeMetaTagAttributes(file: TFile, metaTagName: string) {
		// Similar to applyMetaTagAttributes, this would adjust the rendering of the note.
	}

	replaceFrontMatter(content: string, newData: any): string {
		const yamlStart = content.indexOf("---");
		const yamlEnd = content.indexOf("---", yamlStart + 3);

		let restOfContent = content;
		if (yamlStart !== -1 && yamlEnd !== -1) {
			restOfContent = content.substring(yamlEnd + 3).trimStart();
		} else {
			// No existing frontmatter; start after possible initial line breaks
			restOfContent = content.trimStart();
		}

		const newYaml = YAML.dump(newData);

		return `---\n${newYaml}---\n\n${restOfContent}`;
	}

	getAllTags(file: TFile): string[] {
		const fileCache = this.app.metadataCache.getFileCache(file);
		const tagCache = fileCache?.tags || [];
		const frontmatterTags = fileCache?.frontmatter?.tags;

		let tags: string[] = [];

		// Extract tags from tagCache (e.g., inline tags)
		if (tagCache.length > 0) {
			tags = tags.concat(tagCache.map((tc) => tc.tag));
		}

		// Extract tags from frontmatter
		if (frontmatterTags) {
			if (typeof frontmatterTags === "string") {
				tags.push(frontmatterTags);
			} else if (Array.isArray(frontmatterTags)) {
				tags = tags.concat(frontmatterTags);
			}
		}

		// Remove '#' from tags and duplicates
		tags = tags.map((tag) =>
			tag.startsWith("#") ? tag.substring(1) : tag
		);
		tags = [...new Set(tags)];

		return tags;
	}
}

class MetaTagsSettingTab extends PluginSettingTab {
	plugin: MetaTagsPlugin;

	constructor(app: App, plugin: MetaTagsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "MetaTags Settings" });

		new Setting(containerEl)
			.setName("Tag Base")
			.setDesc("The base tag for MetaTags")
			.addText((text) =>
				text
					.setPlaceholder("Enter base tag")
					.setValue(this.plugin.settings.tagBase)
					.onChange(async (value) => {
						this.plugin.settings.tagBase = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
