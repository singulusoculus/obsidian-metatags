import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	debounce,
	MarkdownView,
	TAbstractFile,
} from "obsidian";
import * as JSYAML from "js-yaml";
import * as YAML from 'yaml';

interface MetaTagsSettings {
	tagBase: string;
	deleteEmptyMetatagProperties: boolean;
	templateFolderPath: string;
}

const DEFAULT_SETTINGS: MetaTagsSettings = {
	tagBase: "mt",
	deleteEmptyMetatagProperties: false,
	templateFolderPath: "",
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

		console.log(this.fileTagCache);

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
			this.app.workspace.on('file-open', async (file: TFile) => {
				if (file && file.extension === 'md') {
				// await this.applyMetaTagAttributes(file);
				await this.updateMetaTagAttributes(file)
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
		const templateFolderPath = this.settings.templateFolderPath.trim();
		let templateFiles: TFile[] = [];
	
		if (templateFolderPath) {
			// If templateFolderPath is specified, use it to locate templates
			const templateFolder = this.app.vault.getAbstractFileByPath(templateFolderPath);
	
			if (templateFolder && templateFolder instanceof TFolder) {
				templateFiles = this.getAllTemplateFiles(templateFolder);
			} else {
				console.warn(`Template folder "${templateFolderPath}" not found.`);
			}
		} else {
			// If no templateFolderPath is specified, search all markdown files for templates
			const allFiles = this.app.vault.getMarkdownFiles();
			for (const file of allFiles) {
				const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (frontmatter) {
					const tags = this.getAllTagsFromFrontmatter(frontmatter);
					if (tags.includes(this.settings.tagBase)) {
						templateFiles.push(file);
					}
				}
			}
		}
	
		for (const file of templateFiles) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
			this.templateCache.set(file.path, frontmatter);
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
		console.log('onMetadataChanged')
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
		await this.updateMetaTagAttributes(file);
	}

	async isTemplateFile(file: TFile): Promise<boolean> {
		const templateFolderPath = this.settings.templateFolderPath.trim();
	
		if (templateFolderPath) {
			// If template folder is specified, check if the file is within that folder
			const templateFolder = this.app.vault.getAbstractFileByPath(templateFolderPath);
			if (!templateFolder || !(templateFolder instanceof TFolder)) {
				return false;
			}
			return file.path.startsWith(templateFolder.path);
		} else {
			// If no template folder is specified, check if the file has the tagBase in its frontmatter tags
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (frontmatter) {
				const tags = this.getAllTagsFromFrontmatter(frontmatter);
				return tags.includes(this.settings.tagBase);
			}
			return false;
		}
	}
	

	async getTemplateFileByName(templateName: string): Promise<TFile | null> {
		const templateFolderPath = this.settings.templateFolderPath.trim();
	
		if (templateFolderPath) {
			// If template folder is specified, look for the template file there
			const templateFilePath = `${templateFolderPath}/${templateName}.md`;
			const templateFile = this.app.vault.getAbstractFileByPath(templateFilePath);
			if (templateFile instanceof TFile) {
				return templateFile;
			} else {
				console.warn(`Template file "${templateFilePath}" not found.`);
				return null;
			}
		} else {
			// If no template folder is specified, search all markdown files for the template
			const allFiles = this.app.vault.getMarkdownFiles();
			for (const file of allFiles) {
				if (file.basename === templateName) {
					const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
					if (frontmatter) {
						const tags = this.getAllTagsFromFrontmatter(frontmatter);
						if (tags.includes(this.settings.tagBase)) {
							return file;
						}
					}
				}
			}
			console.warn(`Template "${templateName}" not found in the vault.`);
			return null;
		}
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
			this.refreshFileView(file);
		}
	}

	async handleMetaTagRemoved(file: TFile, removedTags: string[]) {
		for (const tag of removedTags) {
			if (tag.startsWith(`${this.settings.tagBase}/`)) {
				const metaTagName = tag.replace(
					`${this.settings.tagBase}/`,
					""
				);
				if (this.settings.deleteEmptyMetatagProperties) {
					await this.removeEmptyTemplateProperties(file, metaTagName);
				}
			}
		}
		this.refreshFileView(file);
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
		const noteData = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
		let mergedTemplateData = {};
	
		for (const metaTagName of metaTagNames) {
			const templateFile = await this.getTemplateFileByName(metaTagName);
			if (!templateFile) continue;
	
			const templateData = this.app.metadataCache.getFileCache(templateFile)?.frontmatter || {};
			mergedTemplateData = { ...mergedTemplateData, ...templateData };
		}
	
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

		await this.app.vault.modify(file, newContent);
	}

	async removeEmptyTemplateProperties(file: TFile, metaTagName: string) {
		const noteData = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
		const content = await this.app.vault.read(file);
	
		const templateFile = await this.getTemplateFileByName(metaTagName);
		if (!templateFile) return;
	
		const templateContent = await this.app.vault.read(templateFile);
		const templateData = this.extractFrontmatter(templateContent);
	
		const newData = { ...noteData };
	
		for (const key in newData) {
			if (templateData.hasOwnProperty(key)) {
				const noteValue = newData[key];
				const templateValue = templateData[key];
	
				if (noteValue === "" || noteValue === null) {
					delete newData[key];
				} else if (typeof templateValue === 'boolean') {
					if (noteValue === templateValue) {
						delete newData[key];
					}
				}
				// Optionally handle other data types here
			}
		}
	
		const newContent = this.replaceFrontMatter(content, newData);
		await this.app.vault.modify(file, newContent);
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

		const newYaml = JSYAML.dump(newData);

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

	getMetaTagNamesFromFrontmatter(frontmatter: any): string[] {
		const tags = frontmatter.tags;
		if (!tags) return [];

		let tagList: string[] = [];

		if (typeof tags === "string") {
			tagList.push(tags);
		} else if (Array.isArray(tags)) {
			tagList = tags;
		}

		const metaTagNames = tagList
			.map((tag) => (tag.startsWith("#") ? tag.substring(1) : tag))
			.filter((tag) => tag.startsWith(`${this.settings.tagBase}/`))
			.map((tag) => tag.replace(`${this.settings.tagBase}/`, ""));

		return metaTagNames;
	}

	isMetaTag(tag: string): boolean {
		return tag.startsWith(`${this.settings.tagBase}/`);
	}

	getMetaTagName(tag: string): string {
		return tag.replace(`${this.settings.tagBase}/`, "");
	}

	getAllTagsFromFrontmatter(frontmatter: any): string[] {
		if (!frontmatter || !frontmatter.tags) return [];
	
		let tags: string[] = [];
	
		if (typeof frontmatter.tags === "string") {
			tags.push(frontmatter.tags);
		} else if (Array.isArray(frontmatter.tags)) {
			tags = frontmatter.tags;
		}
	
		// Remove '#' from tags if present
		tags = tags.map((tag) =>
			tag.startsWith("#") ? tag.substring(1) : tag
		);
	
		return tags;
	}
	

	refreshFileView(file: TFile) {
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) {
				// Reload the view to refresh the rendering
				leaf.setViewState(leaf.getViewState(), { reload: true });
			}
		}
	}

	async applyMetaTagAttributes(file: TFile) {
		const metadata = this.app.metadataCache.getFileCache(file);
		const tags = metadata?.frontmatter?.tags;
		if (!tags) return;
	  
		const metaTag = tags.find((tag: any) => tag.startsWith(`${this.settings.tagBase}/`));
		if (!metaTag) return;
	  
		// Extract the template name from the tag
		const templateName = metaTag.split('/')[1];
		const templateFile = this.app.vault.getAbstractFileByPath(`${this.settings.tagBase}/${templateName}.md`);
		if (!templateFile || !(templateFile instanceof TFile)) return;
	  
		// Get properties from the template
		const templateContent = await this.app.vault.read(templateFile);
		const templateProperties = this.extractFrontmatter(templateContent);
	  
		// Apply attributes to properties in the note
		this.addMetaTagAttributesToProperties(file, templateProperties);
	  }

	async updateMetaTagAttributes(file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		if (!this.isCurrentFile(file)) return;
	
		const isTemplate = await this.isTemplateFile(file);
	
		if (isTemplate) {
			this.addMetaTagAttributesToTemplate(file);
			return;
		}
	
		const metadata = this.app.metadataCache.getFileCache(file);
		const tags = metadata?.frontmatter?.tags;
	
		if (!tags) return;
	
		const metaTag = tags.find((tag: any) =>
			tag.startsWith(`${this.settings.tagBase}/`)
		);
		const templateName = metaTag?.split('/')[1];
	
		if (templateName) {
			const templateFile = await this.getTemplateFileByName(templateName);
			if (templateFile) {
				const templateContent = await this.app.vault.read(templateFile);
				const templateProperties = this.extractFrontmatter(templateContent);
				this.addMetaTagAttributesToProperties(file, templateProperties);
			} else {
				this.removeMetaTagAttributesFromProperties(file);
			}
		} else {
			this.removeMetaTagAttributesFromProperties(file);
		}
	}

		addMetaTagAttributesToTemplate(file: TFile) {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;

			const elements = view.containerEl.querySelectorAll('.metadata-property');
			elements.forEach((el) => {
				const propertyKeyEl = el.querySelector('.metadata-property-key')
				propertyKeyEl?.setAttribute('data-metatag', 'true'); // Add attribute to the parent
			});
		}
	  
	  
		addMetaTagAttributesToProperties(file: TFile, templateProperties: any) {
		  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		  if (!view) return;
		
		  // Select all parent elements that contain the child with aria-label
		  const elements = view.containerEl.querySelectorAll('.metadata-property');
		  elements.forEach((el) => {
			  // Find the child element with the aria-label
			const propertyName = el.getAttribute('data-property-key')?.trim();
			const propertyKeyEl = el.querySelector('.metadata-property-key')

			if (propertyName && templateProperties.hasOwnProperty(propertyName)) {
			  propertyKeyEl?.setAttribute('data-metatag', 'true'); // Add attribute to the parent
			}
		  });
		}
		
		// Remove or set data-metatag="false" for all properties
		removeMetaTagAttributesFromProperties(file: TFile) {
		  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		  if (!view) return;

		  
		  const elements = view.containerEl.querySelectorAll('.metadata-property-key[data-metatag="true"]');
		  elements.forEach((el) => {
			el.removeAttribute('data-metatag'); // Remove attribute
			// Optionally set to false:
			// el.setAttribute('data-metatag', 'false');
		  });
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

		isCurrentFile(file: TFile): boolean {
			const activeFile = this.app.workspace.getActiveFile();
			return activeFile?.path === file.path;
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

		containerEl.createEl("h2", { text: "MetaTags" });

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

		new Setting(containerEl)
			.setName("Remove Empty Properties")
			.setDesc("When removing a MetaTag, remove any empty properties associated with the template")
			.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.deleteEmptyMetatagProperties)
						.onChange(async (value) => {
							this.plugin.settings.deleteEmptyMetatagProperties = value;
							await this.plugin.saveSettings();
						})

			);

		new Setting(containerEl)
            .setName("Template Folder Path")
            .setDesc(
                "The folder where your template files are stored. Leave empty for templates to exist anywhere in your vault."
            )
            .addText((text) =>
                text
                    .setPlaceholder("Enter template folder path")
                    .setValue(this.plugin.settings.templateFolderPath)
                    .onChange(async (value) => {
                        this.plugin.settings.templateFolderPath = value.trim();
                        await this.plugin.saveSettings();
                    })
            );
	}
}
