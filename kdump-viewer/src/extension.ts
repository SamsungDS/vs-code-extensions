/*
* Copyright (c) 2021 Samsung Electronics Co., Ltd. All Rights Reserved
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

import { execSync } from 'child_process';
import * as vscode from 'vscode';

const fs = require('fs');
const path = require("path");

let dumpPath = '';

export function activate(context: vscode.ExtensionContext) {
	if (process.platform != "linux") {
		vscode.window.showErrorMessage("Current OS not supported!");
		return;
	}

	vscode.window.showInformationMessage("Please enter driver code and .ko absolute paths in extension settings");

	const directoryTreeViewProvider = new DirectoryViewProvider();
	const callstackTreeViewProvider = new CallstackTreeViewProvider();
	const functionTreeViewProvider = new FunctionTreeViewProvider();

	vscode.window.registerTreeDataProvider('directoryTreeView', directoryTreeViewProvider);
	vscode.window.registerTreeDataProvider('callstackTreeView', callstackTreeViewProvider);
	vscode.window.registerTreeDataProvider('functionTreeView', functionTreeViewProvider);

	let disposableDirectoryTreeView = vscode.commands.registerCommand('directoryTreeView.selectedFolder', (directory: DirectoryTreeItem) => {
		callstackTreeViewProvider.showLines(directory.label);
	});

	let disposableCallstackTreeView = vscode.commands.registerCommand('callstackTreeView.selectedCallstack', (callStack: CallstackTreeItem) => {
		functionTreeViewProvider.showLines(callStack.label);
	});

	let disposableFunctionTreeView = vscode.commands.registerCommand('functionTreeView.selectedFunction', (driverFunction: FunctionTreeItem) => {
		functionTreeViewProvider.showFunction(driverFunction);
	});

	context.subscriptions.push(disposableDirectoryTreeView, disposableCallstackTreeView, disposableFunctionTreeView);
}

function openFile(path: string, searchString: string, type: string) {
	const file = fs.readFileSync(path).toString();
	let lineNumber = 0;
	if (type === 'dump') {
		lineNumber = file.substring(0, file.lastIndexOf(searchString)).split('\n').length;
	}
	else {
		lineNumber = Number(searchString);
	}

	const pos = new vscode.Position(lineNumber, 0);
	const openPath = vscode.Uri.file(path);

	vscode.workspace.openTextDocument(openPath).then(doc => {
		vscode.window.showTextDocument(doc, { preview: false }).then(editor => {
			editor.selections = [new vscode.Selection(pos, pos)];
			var range = new vscode.Range(pos, pos);
			editor.revealRange(range);
		});
	});
}

function getUserDriverLocation() {
	let driverPath = '';
	driverPath = vscode.workspace.getConfiguration().get('kdump.userDriverLocation')!;

	if (driverPath.slice(-1) != '/') {
		driverPath += '/';
	}

	return driverPath;
}

function checkIfFileExist(filePath: string) {
	try {
		if (fs.existsSync(filePath))
			return true;
		else
			return false;
	}
	catch (err) {
		return false;
	}
}

function findFilePath(directoryPath: string, fileName: string): string | null {
	let filePath: string | null = null;

	function searchDirectory(currentPath: string): void {
		const items = fs.readdirSync(currentPath);
		for (const item of items) {
			const itemPath = path.join(currentPath, item);
			const stats = fs.statSync(itemPath);

			if (stats.isDirectory()) {
				// If the item is a directory, recursively search it
				searchDirectory(itemPath);
			}
			else if (item === fileName) {
				// If the item is the desired file, set filePath and return
				filePath = itemPath;
				return;
			}
		}
	}

	searchDirectory(directoryPath);
	return filePath;
}

function openFileUsingGDB(functionString: string, driverName: string) {
	if (driverName == "nvme_core") {
		driverName = "nvme-core";
	}

	// NVMe driver and NVMe Core driver code present inside the same directory. But their .ko is different
	const userDirectory = driverName == "nvme-core" ? "nvme" : driverName;
	const userDriverLocation = getUserDriverLocation();
	const binaryPath = userDriverLocation + userDirectory + "/" + driverName + ".ko";

	if (!checkIfFileExist(binaryPath)) {
		vscode.window.showInformationMessage('Binary not present for ' + driverName);
		return;
	}

	const gdbCmd = 'gdb "' + binaryPath + '" -ex "list *(' + functionString + ')" -ex "q"';
	const gdbCmdResult = execSync(gdbCmd).toString();
	const crashPoint = gdbCmdResult.substring(gdbCmdResult.lastIndexOf("is in")).split('\n')[0].split(':');

	if (crashPoint.length < 2) {
		vscode.window.showInformationMessage('Function not present in given driver binary');
		return;
	}

	const crashLine = crashPoint[1].split(')')[0];
	const tempCrashFile = crashPoint[0].split('/');
	const crashFile = findFilePath(userDriverLocation + userDirectory, tempCrashFile[tempCrashFile.length - 1]);

	if (crashFile !== null)
		openFile(crashFile, crashLine, '');
	else
		vscode.window.showInformationMessage('File found using gdb is not present at given directory');

}

class DirectoryViewProvider implements vscode.TreeDataProvider<DirectoryTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<DirectoryTreeItem | undefined> = new vscode.EventEmitter<DirectoryTreeItem | undefined>();
	readonly onDidChangeTreeData: vscode.Event<DirectoryTreeItem | undefined> = this._onDidChangeTreeData.event;

	private crashDirectory: string = '/var/crash';

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: DirectoryTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: DirectoryTreeItem): vscode.ProviderResult<DirectoryTreeItem[]> {
		var item: DirectoryTreeItem[] = [];

		if (element == null) {
			fs.readdirSync(this.crashDirectory, { withFileTypes: true })
				.filter((dirent: { isDirectory: () => any; }) => dirent.isDirectory())
				.map((dirent: { name: string; }) => {
					var cur = new DirectoryTreeItem(dirent.name);
					item.push(cur);
					cur.command =
					{
						command: "directoryTreeView.selectedFolder",
						title: "Kdump select folder",
						arguments: [cur]
					};
				});
			return Promise.resolve(item);
		}

		return null;
	}

}

class CallstackTreeViewProvider implements vscode.TreeDataProvider<CallstackTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<CallstackTreeItem | undefined> = new vscode.EventEmitter<CallstackTreeItem | undefined>();
	readonly onDidChangeTreeData: vscode.Event<CallstackTreeItem | undefined> = this._onDidChangeTreeData.event;

	private _lines: CallstackTreeItem[] = [];

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: CallstackTreeItem): vscode.TreeItem {
		return element;
	}

	showLines(selectedDumpDirectory: string | vscode.TreeItemLabel | undefined) {
		dumpPath = '/var/crash/' + selectedDumpDirectory + '/vmcore-dmesg.txt';
		openFile(dumpPath, "Call Trace:", 'dump');
		const file = fs.readFileSync(dumpPath).toString();
		let lines = file.split('\n').filter((element: string | string[]) => element.includes("Call Trace:"));
		this._lines = lines.map((lineText: any) => new CallstackTreeItem(`${lineText}`));
		this.refresh();

		//Driver code which started crash sequence
		let fromFirstRIP = file.substring(file.indexOf("RIP:")).split('\n');
		let driverName = '';
		let ripLine = -1;

		for (let i = 0; i < fromFirstRIP.length; i++) {
			if (fromFirstRIP[i].split('[') != undefined) {
				driverName = fromFirstRIP[i].split('[')[1].split(']')[0];
				ripLine = i;
				break;
			}
		}

		if (ripLine == -1) {
			vscode.window.showErrorMessage("Crash did not occur because of any known driver! Extension is stopped. Please reload and give correct driver source code and .ko path");
			return;
		}

		const RIPfunction = fromFirstRIP[ripLine].split(':')[2].split('/')[0];

		openFileUsingGDB(RIPfunction, driverName);

		vscode.window.showInformationMessage('You are viewing first point of driver code which caused crash');
	}

	getChildren(element?: CallstackTreeItem): Thenable<CallstackTreeItem[]> {
		this._lines.forEach((line: CallstackTreeItem) => {
			line.command =
			{
				command: "callstackTreeView.selectedCallstack",
				title: "Kdump selected Callstack",
				arguments: [line]
			};
		});

		return Promise.resolve(this._lines);
	}
}

class FunctionTreeViewProvider implements vscode.TreeDataProvider<FunctionTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<FunctionTreeItem | undefined> = new vscode.EventEmitter<FunctionTreeItem | undefined>();
	readonly onDidChangeTreeData: vscode.Event<FunctionTreeItem | undefined> = this._onDidChangeTreeData.event;

	private _lines: FunctionTreeItem[] = [];

	showLines(selectedCallStack: string | vscode.TreeItemLabel | undefined) {
		//Create CallStack TreeView
		let file = fs.readFileSync(dumpPath).toString();
		file = file.substring(file.lastIndexOf(selectedCallStack) + selectedCallStack?.toString().length).trim()
		let lines = file.substring(0, file.indexOf("Call Trace:")).split('\n');
		if (lines.length == 1) //last call trace
		{
			lines = file.split('\n');
		}
		this._lines = lines.map((lineText: any) => new FunctionTreeItem(`${lineText}`));
		this.refresh();
	}

	showFunction(item: FunctionTreeItem) {
		let functionName = item.label?.toString().trim();
		if (functionName != undefined) {
			if (functionName[functionName.length - 1] == ']') {
				let driverName = functionName.split(']')[1].split(']')[0].split('[')[1];
				functionName = functionName.split(']')[1].split('[')[0].split('/')[0].trim();
				openFileUsingGDB(functionName, driverName);

			}
		}
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: FunctionTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: FunctionTreeItem): Thenable<FunctionTreeItem[]> {
		this._lines.forEach((line: FunctionTreeItem) => {
			line.command = {
				command: "functionTreeView.selectedFunction",
				title: "Kdump selected function",
				arguments: [line]
			};
		});

		return Promise.resolve(this._lines);
	}
}

class DirectoryTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
	) {
		super(
			label,
		);
		this.iconPath = new vscode.ThemeIcon('folder');
	}
}

class CallstackTreeItem extends vscode.TreeItem {
	constructor(
		label: string
	) {
		super(
			label,
			vscode.TreeItemCollapsibleState.None
		);
	}
}

class FunctionTreeItem extends vscode.TreeItem {
	constructor(
		label: string
	) {
		super(
			label,
			vscode.TreeItemCollapsibleState.None
		);
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }

function line(value: FunctionTreeItem, index: number, array: FunctionTreeItem[]): void {
	throw new Error('Function not implemented.');
}
