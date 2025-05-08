import { Option, pipe } from "effect"

export const firstParagraph = (str: string) => str.trim().split("\n")[0].trim()

export const removeQuotes = (str: string) => str.startsWith("\"") && str.endsWith("\"") ? str.slice(1, -1) : str

export const removePeriod = (str: string) => str.endsWith(".") ? str.slice(0, -1) : str

export const nonEmpty = (str: string | undefined) =>
  pipe(
    Option.fromNullable(str),
    Option.map((_) => _.trim()),
    Option.filter((_) => _.length > 0)
  )

export const truncateWords = (str: string, nWords: number, suffix = "...") => {
  const truncated = str.split(" ", nWords).join(" ")
  return truncated.length < str.length ? truncated + suffix : truncated
}

export const truncate = (str: string, len: number) => str.length > len ? str.substring(0, len - 3) + "..." : str
