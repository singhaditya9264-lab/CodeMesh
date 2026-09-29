import axiosInstance from "@/api/pistonApi"
import { Language, RunContext as RunContextType } from "@/types/run"
import langMap from "lang-map"
import {
    ReactNode,
    createContext,
    useContext,
    useEffect,
    useState,
} from "react"
import toast from "react-hot-toast"
import { useFileSystem } from "./FileContext"

declare global {
    interface Window {
        loadPyodide?: any
    }
}

const DEFAULT_LANGUAGES: Language[] = [
    { language: "python", version: "3.10.0", aliases: ["py", "python3"] },
    { language: "javascript", version: "1.32.3", aliases: ["js", "node"] },
    { language: "typescript", version: "5.0.3", aliases: ["ts"] },
    { language: "c++", version: "10.2.0", aliases: ["cpp", "cplusplus"] },
    { language: "c", version: "10.2.0", aliases: ["gcc"] },
    { language: "java", version: "15.0.2", aliases: ["jar"] },
]

const RunCodeContext = createContext<RunContextType | null>(null)

export const useRunCode = () => {
    const context = useContext(RunCodeContext)
    if (context === null) {
        throw new Error("useRunCode must be used within a RunCodeContextProvider")
    }
    return context
}

// Browser JavaScript runner
const runJavaScriptLocally = (code: string): string => {
    const logs: string[] = []
    const originalLog = console.log
    const originalError = console.error

    console.log = (...args: any[]) => {
        logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" "))
    }
    console.error = (...args: any[]) => {
        logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" "))
    }

    try {
        const result = new Function(code)()
        if (result !== undefined && logs.length === 0) {
            logs.push(String(result))
        }
    } catch (err: any) {
        logs.push(err.toString())
    } finally {
        console.log = originalLog
        console.error = originalError
    }

    return logs.join("\n")
}

let pyodideInstance: any = null

// Browser Python runner (using Pyodide)
const runPythonLocally = async (code: string): Promise<string> => {
    if (!window.loadPyodide) {
        return "Pyodide failed to load. Please make sure the script tag is added to index.html."
    }

    if (!pyodideInstance) {
        pyodideInstance = await window.loadPyodide({
            indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/",
        })
    }

    // Capture Python stdout
    await pyodideInstance.runPythonAsync(`
import sys
import io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
    `)

    try {
        await pyodideInstance.runPythonAsync(code)
        const stdout = await pyodideInstance.runPythonAsync("sys.stdout.getvalue()")
        const stderr = await pyodideInstance.runPythonAsync("sys.stderr.getvalue()")
        return stderr ? stderr : stdout
    } catch (err: any) {
        return err.toString()
    }
}

const RunCodeContextProvider = ({ children }: { children: ReactNode }) => {
    const { activeFile } = useFileSystem()
    const [input, setInput] = useState<string>("")
    const [output, setOutput] = useState<string>("")
    const [isRunning, setIsRunning] = useState<boolean>(false)
    const [supportedLanguages, setSupportedLanguages] = useState<Language[]>(DEFAULT_LANGUAGES)
    const [selectedLanguage, setSelectedLanguage] = useState<Language>(DEFAULT_LANGUAGES[0])

    useEffect(() => {
        const fetchSupportedLanguages = async () => {
            try {
                const languages = await axiosInstance.get("/runtimes")
                if (languages.data && languages.data.length > 0) {
                    setSupportedLanguages(languages.data)
                }
            } catch {
                setSupportedLanguages(DEFAULT_LANGUAGES)
            }
        }
        fetchSupportedLanguages()
    }, [])

    // Automatically pick language from file extension
    useEffect(() => {
        if (!activeFile?.name) return

        const extension = activeFile.name.split(".").pop()?.toLowerCase()
        if (extension) {
            const languageName = langMap.languages(extension) || []
            const language = supportedLanguages.find(
                (lang) =>
                    lang.aliases.includes(extension) ||
                    lang.language.toLowerCase() === extension ||
                    languageName.includes(lang.language.toLowerCase()),
            )
            if (language) {
                setSelectedLanguage(language)
            }
        }
    }, [activeFile?.name, supportedLanguages])

    const runCode = async () => {
        try {
            if (!selectedLanguage) {
                return toast.error("Please select a language to run the code")
            } else if (!activeFile) {
                return toast.error("Please open a file to run the code")
            }

            toast.loading("Running code...")
            setIsRunning(true)

            const { language, version } = selectedLanguage
            const isPy = language.toLowerCase() === "python" || selectedLanguage.aliases?.includes("py")
            const isJs = language.toLowerCase() === "javascript" || selectedLanguage.aliases?.includes("js")

            // Try backend / Piston API first
            try {
                const response = await axiosInstance.post("/execute", {
                    language,
                    version,
                    files: [{ name: activeFile.name, content: activeFile.content }],
                    stdin: input,
                })

                if (response.data.run.stderr) {
                    setOutput(response.data.run.stderr)
                } else {
                    setOutput(response.data.run.stdout)
                }
            } catch {
                // In-browser execution fallbacks when API gives 401
                if (isPy) {
                    const pyResult = await runPythonLocally(activeFile.content)
                    setOutput(pyResult || "Code executed successfully (no output).")
                } else if (isJs) {
                    const jsResult = runJavaScriptLocally(activeFile.content)
                    setOutput(jsResult || "Code executed successfully (no output).")
                } else {
                    toast.error("Execution failed: external runtime unreachable")
                }
            }

            setIsRunning(false)
            toast.dismiss()
        } catch (error: any) {
            console.error(error)
            setIsRunning(false)
            toast.dismiss()
            toast.error("Failed to run the code")
        }
    }

    return (
        <RunCodeContext.Provider
            value={{
                setInput,
                output,
                isRunning,
                supportedLanguages,
                selectedLanguage,
                setSelectedLanguage,
                runCode,
            }}
        >
            {children}
        </RunCodeContext.Provider>
    )
}

export { RunCodeContextProvider }
export default RunCodeContext