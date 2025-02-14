import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { uuid } from 'uuidv4'
import * as vscode from 'vscode'
import { NotificationType, RequestType } from 'vscode-jsonrpc'
import * as lsp from 'vscode-languageserver-protocol'
import { generatePipeName, inferJuliaNumThreads } from '../utils'
import * as net from 'net'
import * as rpc from 'vscode-jsonrpc/node'
import { Subject } from 'await-notify'
import { JuliaExecutablesFeature } from '../juliaexepath'
import { join } from 'path'
import { getCrashReportingPipename, handleNewCrashReportFromException } from '../telemetry'
import { getAbsEnvPath } from '../jlpkgenv'

interface TestItemDetail {
    id: string,
    label: string
    range: lsp.Range
    code?: string
    code_range?: lsp.Range
    option_default_imports?: boolean
    option_tags?: string[]
    error?: string
}

interface PublishTestItemsParams {
    uri: lsp.URI
    version: number,
    project_path: string,
    package_path: string,
    package_name: string,
    testitemdetails: TestItemDetail[]
}

interface TestserverRunTestitemRequestParams {
    uri: string
    packageName: string
    useDefaultUsings: boolean
    line: number
    column: number
    code: string
}

interface TestMessage {
    message: string
    location: lsp.Location
}
interface TestserverRunTestitemRequestParamsReturn {
    status: string
    message: TestMessage[] | null,
    duration: number | null
}

export const notifyTypeTextDocumentPublishTestitems = new NotificationType<PublishTestItemsParams>('julia/publishTestitems')
const requestTypeExecuteTestitem = new RequestType<TestserverRunTestitemRequestParams, TestserverRunTestitemRequestParamsReturn, void>('testserver/runtestitem')
const requestTypeRevise = new RequestType<void, string, void>('testserver/revise')

class TestProcess {
    private process: ChildProcessWithoutNullStreams
    private connection: lsp.MessageConnection
    private testRun: vscode.TestRun
    public launchError: Error | null = null

    isConnected() {
        return this.connection
    }

    public async start(context: vscode.ExtensionContext, juliaExecutablesFeature: JuliaExecutablesFeature, outputChannel: vscode.OutputChannel, projectPath: string, packagePath: string, packageName: string) {
        const pipename = generatePipeName(uuid(), 'vsc-jl-ts')

        const connected = new Subject()

        const server = net.createServer((socket: net.Socket) => {
            // socket.on('close', hadError => {
            //     g_onExit.fire(hadError)
            //     g_connection = undefined
            //     server.close()
            // })

            this.connection = rpc.createMessageConnection(
                new rpc.StreamMessageReader(socket),
                new rpc.StreamMessageWriter(socket)
            )

            this.connection.listen()

            connected.notify()
        })

        server.listen(pipename)

        const juliaExecutable = await juliaExecutablesFeature.getActiveJuliaExecutableAsync()

        const pkgenvpath = await getAbsEnvPath()

        const jlArgs = [
            `--project=${pkgenvpath}`,
            '--startup-file=no',
            '--history-file=no',
            '--depwarn=no'
        ]

        const nthreads = inferJuliaNumThreads()

        if (nthreads==='auto') {
            jlArgs.push('--threads=auto')
        }

        const jlEnv = {
            JULIA_REVISE: 'off'
        }

        if (nthreads!=='auto' && nthreads!=='') {
            jlEnv['JULIA_NUM_THREADS'] = nthreads
        }

        this.process = spawn(
            juliaExecutable.file,
            [
                ...juliaExecutable.args,
                ...jlArgs,
                join(context.extensionPath, 'scripts', 'testserver', 'testserver_main.jl'),
                pipename,
                `v:${projectPath}`,
                `v:${packagePath}`,
                `v:${packageName}`,
                getCrashReportingPipename()
            ],
            {
                env: {
                    ...process.env,
                    ...jlEnv
                }
            }
        )

        this.process.stdout.on('data', data => {
            const dataAsString = String(data)
            if (this.testRun) {
                this.testRun.appendOutput(dataAsString.split('\n').join('\n\r'))
            }

            outputChannel.append(dataAsString)
        })

        this.process.stderr.on('data', data => {
            const dataAsString = String(data)
            if (this.testRun) {
                this.testRun.appendOutput(dataAsString.split('\n').join('\n\r'))
            }

            outputChannel.append(dataAsString)
        })

        this.process.on('exit', (code: number, signal: NodeJS.Signals) => {
            if(this.connection) {
                this.connection.dispose()
                this.connection = null
            }
        })

        this.process.on('error', (err: Error) => {
            connected.notify()
            handleNewCrashReportFromException(err, 'Extension')
            this.launchError = err
        })

        console.log(this.process.killed)

        await connected.wait()

        console.log('OK')
    }

    public async revise() {
        return await this.connection.sendRequest(requestTypeRevise, undefined)
    }

    public async kill() {
        this.process.kill()
    }


    public async executeTest(packageName: string, useDefaultUsings: boolean, location: lsp.Location, code: string, testRun: vscode.TestRun, token: vscode.CancellationToken) {
        this.testRun = testRun

        try {
            const result = await this.connection.sendRequest(requestTypeExecuteTestitem, { uri: location.uri, packageName: packageName, useDefaultUsings: useDefaultUsings, line: location.range.start.line, column: location.range.start.character, code: code })
            this.testRun = undefined
            return result
        }
        catch (err) {
            this.testRun = undefined
            if(err.code === -32097 && token.isCancellationRequested) {
                return {status: 'canceled', message: null, duration: null}
            }
            else {
                return {status: 'crashed', message: null, duration: null}
            }
        }
    }
}

export class TestFeature {
    private controller: vscode.TestController
    private testitems: WeakMap<vscode.TestItem, { testitem: TestItemDetail, projectPath: string, packagePath: string, packageName: string }> = new WeakMap<vscode.TestItem, { testitem: TestItemDetail, projectPath: string, packagePath: string, packageName: string }>()
    private testProcesses: Map<string, TestProcess> = new Map<string, TestProcess>()
    private outputChannel: vscode.OutputChannel

    constructor(private context: vscode.ExtensionContext, private executableFeature: JuliaExecutablesFeature) {
        try {
            this.outputChannel = vscode.window.createOutputChannel('Julia Testserver')

            this.controller = vscode.tests.createTestController(
                'juliaTests',
                'Julia Tests'
            )

            this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, async (request, token) => {
                try {
                    await this.runHandler(request, token)
                }
                catch (err) {
                    handleNewCrashReportFromException(err, 'Extension')
                    throw (err)
                }
            }, true)
        // this.controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, this.runHandler.bind(this), false)
        // this.controller.createRunProfile('Coverage', vscode.TestRunProfileKind.Coverage, this.runHandler.bind(this), false)
        }
        catch (err) {
            handleNewCrashReportFromException(err, 'Extension')
            throw (err)
        }
    }

    public publishTestitemsHandler(params: PublishTestItemsParams) {
        const uri = vscode.Uri.parse(params.uri)

        let fileTestitem = this.controller.items.get(params.uri)

        if (!fileTestitem && params.testitemdetails.length > 0) {
            const filename = vscode.workspace.asRelativePath(uri.fsPath)

            fileTestitem = this.controller.createTestItem(params.uri, filename, uri)
            this.controller.items.add(fileTestitem)
        }
        else if (fileTestitem && params.testitemdetails.length === 0) {
            this.controller.items.delete(fileTestitem.id)
        }

        if (params.testitemdetails.length > 0 ) {
            fileTestitem.children.replace(params.testitemdetails.map(i => {
                const testitem = this.controller.createTestItem(i.id, i.label, vscode.Uri.parse(params.uri))
                if (i.error) {
                    testitem.error = i.error
                }
                else if (params.package_path==='') {
                    testitem.error = 'Unable to identify a Julia package for this test item.'
                }
                else {
                    testitem.tags = i.option_tags.map(j => new vscode.TestTag(j))
                }
                this.testitems.set(testitem, {testitem: i, projectPath: params.project_path, packagePath: params.package_path, packageName: params.package_name})
                testitem.range = new vscode.Range(i.range.start.line, i.range.start.character, i.range.end.line, i.range.end.character)

                return testitem
            }))
        }
    }

    walkTestTree(item: vscode.TestItem, itemsToRun: vscode.TestItem[]) {
        if (this.testitems.has(item)) {
            itemsToRun.push(item)
        }
        else {
            item.children.forEach(i=>this.walkTestTree(i, itemsToRun))
        }
    }

    async runHandler(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken
    ) {
        const testRun = this.controller.createTestRun(request, undefined, true)

        const activeTestProccess: TestProcess[] = []

        testRun.token.onCancellationRequested(() => {
            for( const p of activeTestProccess) {
                p.kill()
            }
        })

        const itemsToRun: vscode.TestItem[] = []

        // TODO Handle exclude
        if (!request.include) {
            this.controller.items.forEach(i=>this.walkTestTree(i, itemsToRun))
        }
        else {
            request.include.forEach(i => this.walkTestTree(i, itemsToRun))
        }

        for (const i of itemsToRun) {
            testRun.enqueued(i)
        }

        for (const i of itemsToRun) {
            if(testRun.token.isCancellationRequested) {
                testRun.skipped(i)
            }
            else {
                testRun.started(i)

                const details = this.testitems.get(i)

                if (i.error) {
                    testRun.errored(i, new vscode.TestMessage(i.error))
                }
                else {

                    let testProcess: TestProcess = null

                    if(!this.testProcesses.has(JSON.stringify({projectPath: details.projectPath, packagePath: details.packagePath, packageName: details.packageName}))) {
                        testProcess = new TestProcess()
                        await testProcess.start(this.context, this.executableFeature, this.outputChannel, details.projectPath, details.packagePath, details.packageName)
                        this.testProcesses.set(JSON.stringify({projectPath: details.projectPath, packagePath: details.packagePath, packageName: details.packageName}), testProcess)
                    }
                    else {
                        testProcess = this.testProcesses.get(JSON.stringify({projectPath: details.projectPath, packagePath: details.packagePath, packageName: details.packageName}))

                        const status = await testProcess.revise()

                        if (status !== 'success') {
                            await testProcess.kill()

                            this.outputChannel.appendLine('RESTARTING TEST SERVER')

                            testProcess = new TestProcess()
                            await testProcess.start(this.context, this.executableFeature, this.outputChannel, details.projectPath, details.packagePath, details.packageName)
                            this.testProcesses.set(JSON.stringify({projectPath: details.projectPath, packagePath: details.packagePath, packageName: details.packageName}), testProcess)
                        }
                    }

                    if(testProcess.isConnected()) {
                        const code = details.testitem.code

                        const location = {
                            uri: i.uri.toString(),
                            range: details.testitem.code_range
                        }

                        activeTestProccess.push(testProcess)
                        const result = await testProcess.executeTest(details.packageName, details.testitem.option_default_imports, location, code, testRun, testRun.token)
                        activeTestProccess.pop()

                        if (result.status === 'passed') {
                            testRun.passed(i, result.duration)
                        }
                        else if (result.status === 'errored') {
                            const message = new vscode.TestMessage(result.message[0].message)
                            message.location = new vscode.Location(vscode.Uri.parse(result.message[0].location.uri), new vscode.Position(result.message[0].location.range.start.line, result.message[0].location.range.start.character))
                            testRun.errored(i, message, result.duration)
                        }
                        else if (result.status === 'failed') {
                            const messages = result.message.map(i => {
                                const message = new vscode.TestMessage(i.message)
                                message.location = new vscode.Location(vscode.Uri.parse(i.location.uri), new vscode.Position(i.location.range.start.line, i.location.range.start.character))
                                return message
                            })
                            testRun.failed(i, messages, result.duration)
                        }
                        else if (result.status === 'crashed') {
                            const message = new vscode.TestMessage('The test process crashed while running this test.')
                            testRun.errored(i, message)

                            this.testProcesses.delete(JSON.stringify({projectPath: details.projectPath, packagePath: details.packagePath, packageName: details.packageName}))
                        }
                        else if (result.status === 'canceled') {
                            testRun.skipped(i)

                            this.testProcesses.delete(JSON.stringify({projectPath: details.projectPath, packagePath: details.packagePath, packageName: details.packageName}))
                        }
                    }
                    else {
                        if(testProcess.launchError) {
                            testRun.errored(i, new vscode.TestMessage(`Unable to launch the test process: ${testProcess.launchError.message}`))
                        }
                        else {
                            testRun.errored(i, new vscode.TestMessage('Unable to launch the test process.'))
                        }
                    }
                }
            }
        }

        // testRun.failed(this.controller.items.get('test1'), new vscode.TestMessage('Well that did not work'))

        testRun.end()
    }

    public dispose() {

    }
}
