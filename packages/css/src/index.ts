import type { LanguageServicePlugin, LanguageServicePluginInstance } from '@volar/language-service';
import * as css from 'vscode-css-languageservice';
import * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';

export default (): LanguageServicePlugin => (context): LanguageServicePluginInstance => {

	const triggerCharacters: LanguageServicePluginInstance = {
		// https://github.com/microsoft/vscode/blob/09850876e652688fb142e2e19fd00fd38c0bc4ba/extensions/css-language-features/server/src/cssServer.ts#L97
		triggerCharacters: ['/', '-', ':'],
	};
	if (!context) {
		return triggerCharacters;
	}

	let inited = false;

	const stylesheets = new WeakMap<TextDocument, [number, css.Stylesheet]>();
	const cssLs = css.getCSSLanguageService({ fileSystemProvider: context.fileSystemProvider });
	const scssLs = css.getSCSSLanguageService({ fileSystemProvider: context.fileSystemProvider });
	const lessLs = css.getLESSLanguageService({ fileSystemProvider: context.fileSystemProvider });
	const postcssLs: css.LanguageService = {
		...scssLs,
		doValidation: (document, stylesheet, documentSettings) => {
			let errors = scssLs.doValidation(document, stylesheet, documentSettings);
			errors = errors.filter(error => error.code !== 'css-semicolonexpected');
			errors = errors.filter(error => error.code !== 'css-ruleorselectorexpected');
			errors = errors.filter(error => error.code !== 'unknownAtRules');
			return errors;
		},
	};

	return {

		...triggerCharacters,

		async resolveRuleContext(context) {
			await worker(context.document, (stylesheet, cssLs) => {
				context.css = {
					stylesheet,
					languageService: cssLs,
				};
			});
			return context;
		},

		async provideCompletionItems(document, position) {
			return worker(document, async (stylesheet, cssLs) => {

				const settings = await context.configurationHost?.getConfiguration<css.LanguageSettings>(document.languageId);
				const cssResult = context.documentContext
					? await cssLs.doComplete2(document, position, stylesheet, context.documentContext, settings?.completion)
					: await cssLs.doComplete(document, position, stylesheet, settings?.completion);

				return cssResult;
			});
		},

		provideRenameRange(document, position) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.prepareRename(document, position, stylesheet);
			});
		},

		provideRenameEdits(document, position, newName) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.doRename(document, position, newName, stylesheet);
			});
		},

		provideCodeActions(document, range, context) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.doCodeActions2(document, range, context, stylesheet) as vscode.CodeAction[];
			});
		},

		provideDefinition(document, position) {
			return worker(document, (stylesheet, cssLs) => {

				const location = cssLs.findDefinition(document, position, stylesheet);

				if (location) {
					return [vscode.LocationLink.create(location.uri, location.range, location.range)];
				}
			});
		},

		async provideSyntacticDiagnostics(document) {
			return worker(document, async (stylesheet, cssLs) => {

				const settings = await context.configurationHost?.getConfiguration<css.LanguageSettings>(document.languageId);

				return cssLs.doValidation(document, stylesheet, settings) as vscode.Diagnostic[];
			});
		},

		async provideHover(document, position) {
			return worker(document, async (stylesheet, cssLs) => {

				const settings = await context.configurationHost?.getConfiguration<css.LanguageSettings>(document.languageId);

				return cssLs.doHover(document, position, stylesheet, settings?.hover);
			});
		},

		provideReferences(document, position) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.findReferences(document, position, stylesheet);
			});
		},

		provideDocumentHighlights(document, position) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.findDocumentHighlights(document, position, stylesheet);
			});
		},

		async provideLinks(document) {
			return await worker(document, (stylesheet, cssLs) => {

				if (!context.documentContext)
					return;

				return cssLs.findDocumentLinks2(document, stylesheet, context.documentContext);
			});
		},

		provideDocumentSymbols(document) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.findDocumentSymbols2(document, stylesheet);
			});
		},

		provideDocumentColors(document) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.findDocumentColors(document, stylesheet);
			});
		},

		provideColorPresentations(document, color, range) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.getColorPresentations(document, stylesheet, color, range);
			});
		},

		provideFoldingRanges(document) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.getFoldingRanges(document, stylesheet);
			});
		},

		provideSelectionRanges(document, positions) {
			return worker(document, (stylesheet, cssLs) => {
				return cssLs.getSelectionRanges(document, positions, stylesheet);
			});
		},

		async provideDocumentFormattingEdits(document, formatRange, options) {
			return worker(document, async (_stylesheet, cssLs) => {

				const options_2 = await context.configurationHost?.getConfiguration<css.CSSFormatConfiguration & { enable: boolean; }>(document.languageId + '.format');
				if (options_2?.enable === false) {
					return;
				}

				return cssLs.format(document, formatRange, {
					...options_2,
					...options,
				});
			});
		},
	};

	async function initCustomData() {
		if (!inited) {

			context?.configurationHost?.onDidChangeConfiguration(async () => {
				const customData = await getCustomData();
				cssLs.setDataProviders(true, customData);
				scssLs.setDataProviders(true, customData);
				lessLs.setDataProviders(true, customData);
			});

			const customData = await getCustomData();
			cssLs.setDataProviders(true, customData);
			scssLs.setDataProviders(true, customData);
			lessLs.setDataProviders(true, customData);
			inited = true;
		}
	}

	async function getCustomData() {

		const configHost = context?.configurationHost;

		if (configHost) {

			const customData: string[] = await configHost.getConfiguration('css.customData') ?? [];
			const newData: css.ICSSDataProvider[] = [];

			for (const customDataPath of customData) {
				try {
					const jsonPath = path.resolve(customDataPath);
					newData.push(css.newCSSDataProvider(require(jsonPath)));
				}
				catch (error) {
					console.error(error);
				}
			}

			return newData;
		}

		return [];
	}

	function getCssLs(lang: string) {
		switch (lang) {
			case 'css': return cssLs;
			case 'scss': return scssLs;
			case 'less': return lessLs;
			case 'postcss': return postcssLs;
		}
	}

	function getStylesheet(document: TextDocument) {

		const cache = stylesheets.get(document);
		if (cache) {
			const [cacheVersion, cacheStylesheet] = cache;
			if (cacheVersion === document.version) {
				return cacheStylesheet;
			}
		}

		const cssLs = getCssLs(document.languageId);
		if (!cssLs)
			return;

		const stylesheet = cssLs.parseStylesheet(document);
		stylesheets.set(document, [document.version, stylesheet]);

		return stylesheet;
	}

	async function worker<T>(document: TextDocument, callback: (stylesheet: css.Stylesheet, cssLs: css.LanguageService) => T) {

		const stylesheet = getStylesheet(document);
		if (!stylesheet)
			return;

		const cssLs = getCssLs(document.languageId);
		if (!cssLs)
			return;

		await initCustomData();

		return callback(stylesheet, cssLs);
	}
};
