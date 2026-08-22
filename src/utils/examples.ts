/**
 * Ready-made programs, added from the Examples menu.
 *
 * Each one is a single file that compiles and runs on its own, so choosing an
 * example and pressing Run always does something. They are written the way a
 * course would write them — ordinary Java, heavily commented — rather than in a
 * way that shows off this environment.
 *
 * Two rules they all have to keep, both enforced by `examples.test.ts`:
 *
 *   - no annotation that takes arguments, which this javac cannot compile;
 *   - no *fully-qualified* `java.io.File` and friends. The plain name resolves
 *     to jcoder's working version, while `java.io.File` names TeaVM's, which
 *     compiles and then silently finds nothing.
 */

export interface Example {
  id: string
  /** As it appears in the menu. */
  label: string
  /** Class and file name; also what the Main picker is set to. */
  className: string
  /** One line for the menu's title attribute. */
  summary: string
  source: string
}

const EXAMPLE_1 = `import java.util.Scanner;

/**
 * Example 1: Simple Calculation
 *
 * Reading a number that was typed in, and doing arithmetic with it.
 * Everything typed arrives as text, so it has to be converted first.
 */
public class Example1 {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);

        System.out.print("How many apples do you have? ");
        String typed = input.nextLine();
        int apples = Integer.parseInt(typed);   // text -> whole number

        System.out.print("How much does one apple cost, in pence? ");
        int pence = Integer.parseInt(input.nextLine());

        int total = apples * pence;

        System.out.println();
        System.out.println("Apples:    " + apples);
        System.out.println("Each:      " + pence + "p");
        System.out.println("Total:     " + total + "p");

        // Whole-number division and remainder split the pence up.
        int pounds = total / 100;      // how many whole pounds
        int leftOver = total % 100;    // what is left over
        System.out.println("That is:   " + pounds + " pounds and " + leftOver + "p");

        // Dividing by 2.0 rather than 2 keeps the decimal part.
        double half = total / 2.0;
        System.out.println("Half:      " + half + "p");
    }
}
`

const EXAMPLE_2 = `import java.util.Scanner;

/**
 * Example 2: Basic Control Structures
 *
 * A while loop that repeats until the user stops it, a for loop that visits
 * every letter of a word, and if / else if / else to decide what to do.
 */
public class Example2 {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);
        boolean goAgain = true;

        // WHILE: repeats for as long as the condition stays true.
        while (goAgain) {
            System.out.print("Enter a word: ");
            String word = input.nextLine();

            int vowels = 0;

            // FOR: counts i from 0 up to the last character position.
            for (int i = 0; i < word.length(); i++) {
                char letter = Character.toLowerCase(word.charAt(i));

                // IF / ELSE IF / ELSE: choose between three cases.
                if (letter == 'a' || letter == 'e' || letter == 'i'
                        || letter == 'o' || letter == 'u') {
                    System.out.println("  " + i + ": " + letter + " is a vowel");
                    vowels = vowels + 1;
                } else if (Character.isLetter(letter)) {
                    System.out.println("  " + i + ": " + letter + " is a consonant");
                } else {
                    System.out.println("  " + i + ": " + letter + " is not a letter");
                }
            }

            System.out.println("'" + word + "' has " + vowels + " vowel(s).");

            System.out.print("Go again (yes/no)? ");
            String answer = input.nextLine();
            goAgain = answer.equalsIgnoreCase("yes") || answer.equalsIgnoreCase("y");
        }

        System.out.println("Finished.");
    }
}
`

const EXAMPLE_3 = `import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;

/**
 * Example 3: Basic Data Structures
 *
 * Four ways to hold more than one value, and what each is good at.
 * This one needs no input — just press Run.
 */
public class Example3 {
    public static void main(String[] args) {

        // ---- Array: a fixed number of slots, counted from 0 ----
        int[] scores = { 7, 4, 9, 2 };
        System.out.println("Array holds " + scores.length + " numbers");
        System.out.println("  first = " + scores[0] + ", last = " + scores[scores.length - 1]);
        scores[1] = 5;                       // slots can be changed
        Arrays.sort(scores);                 // but the size never changes
        System.out.println("  sorted: " + Arrays.toString(scores));
        System.out.println();

        // ---- Two-dimensional array: a grid, [row][column] ----
        int[][] grid = { { 1, 2, 3 }, { 4, 5, 6 } };
        System.out.println("Grid row 1, column 2 = " + grid[1][2]);
        for (int row = 0; row < grid.length; row++) {
            System.out.println("  row " + row + ": " + Arrays.toString(grid[row]));
        }
        System.out.println();

        // ---- ArrayList: grows and shrinks as you go ----
        ArrayList<String> names = new ArrayList<String>();
        names.add("Ada");
        names.add("Alan");
        names.add("Grace");
        names.remove("Alan");                // by value
        System.out.println("ArrayList: " + names);
        System.out.println("  size = " + names.size());
        System.out.println("  item 0 = " + names.get(0));
        System.out.println("  has Grace? " + names.contains("Grace"));
        System.out.println();

        // ---- HashMap: look a value up by a key instead of a position ----
        HashMap<String, Integer> ages = new HashMap<String, Integer>();
        ages.put("Ada", 36);
        ages.put("Grace", 45);
        ages.put("Ada", 37);                 // same key again replaces the value
        System.out.println("HashMap: Ada is " + ages.get("Ada"));
        for (String key : ages.keySet()) {
            System.out.println("  " + key + " -> " + ages.get(key));
        }
    }
}
`

const EXAMPLE_4 = `import java.io.File;
import java.io.PrintWriter;
import java.util.Scanner;

/**
 * Example 4: File Writing and Reading
 *
 * Writes what you type into Example4_Data.txt, then reads it back.
 * Look in the file list on the left after running: the file is really there.
 */
public class Example4 {
    public static void main(String[] args) throws Exception {
        Scanner input = new Scanner(System.in);
        String fileName = "Example4_Data.txt";

        // ---- Writing ----
        PrintWriter out = new PrintWriter(fileName);

        for (int i = 1; i <= 3; i++) {
            System.out.print("Friend " + i + " - first name: ");
            String name = input.nextLine();

            System.out.print("Friend " + i + " - age: ");
            String age = input.nextLine();

            // One record per line, with a comma between the two fields.
            out.println(name + "," + age);
        }

        out.close();     // close() is what actually saves the file
        System.out.println();
        System.out.println("Saved " + fileName);
        System.out.println();

        // ---- Reading it back ----
        Scanner file = new Scanner(new File(fileName));

        while (file.hasNextLine()) {
            String line = file.nextLine();

            // split() cuts the line wherever it finds a comma.
            String[] parts = line.split(",");
            String name = parts[0];
            int age = Integer.parseInt(parts[1]);

            System.out.println(name + " is " + age + ", and next year will be " + (age + 1));
        }

        file.close();
    }
}
`

const EXAMPLE_5 = `/**
 * Example 5: Multiple Classes
 *
 * One class to run, and another to describe a thing. Each Book object keeps
 * its own values; the methods say what a Book can do.
 */
public class Example5 {
    public static void main(String[] args) {
        Book emma = new Book("Emma", "Jane Austen", 474);
        Book holes = new Book("Holes", "Louis Sachar", 233);

        emma.describe();
        holes.describe();
        System.out.println();

        // A static method belongs to the class rather than to one object.
        System.out.println("The longer book is " + Book.longer(emma, holes).getTitle());
        System.out.println();

        holes.read(50);
        holes.read(150);
        holes.describe();
    }
}

/** A second class, in the same file. */
class Book {
    // Fields: what every Book remembers. private = only Book can touch them.
    private String title;
    private String author;
    private int pages;
    private int pagesRead;

    /** Constructor: runs once, when you say new Book(...). */
    Book(String title, String author, int pages) {
        this.title = title;      // "this.title" is the field,
        this.author = author;    // "title" on the right is the parameter
        this.pages = pages;
        this.pagesRead = 0;
    }

    /** A getter lets other classes read a private field. */
    String getTitle() {
        return title;
    }

    void read(int howMany) {
        pagesRead = pagesRead + howMany;
        if (pagesRead > pages) {
            pagesRead = pages;   // cannot read past the end
        }
    }

    void describe() {
        int percent = pagesRead * 100 / pages;
        System.out.println(title + " by " + author);
        System.out.println("  " + pages + " pages, " + percent + "% read");
    }

    /** Static: called on the class itself, as Book.longer(a, b). */
    static Book longer(Book one, Book two) {
        if (one.pages >= two.pages) {
            return one;
        }
        return two;
    }
}
`

const EXAMPLE_6 = `/**
 * Example 6: Inheritance
 *
 * Dog and Cat are both Animals, so they get everything Animal has and can
 * change the parts that differ. The same call then behaves differently
 * depending on the object — which is called polymorphism.
 */
public class Example6 {
    public static void main(String[] args) {
        // All three fit in an Animal[], because a Dog IS an Animal.
        Animal[] pets = { new Dog("Rex"), new Cat("Momo"), new Animal("Spike") };

        for (Animal pet : pets) {
            pet.introduce();     // same line, three different results
        }
        System.out.println();

        Dog rex = new Dog("Rex");
        rex.introduce();         // inherited from Animal
        rex.fetch();             // only a Dog has this

        System.out.println();
        System.out.println("Is rex an Animal? " + (rex instanceof Animal));
    }
}

/** The parent class. */
class Animal {
    // protected = this class and anything that extends it can use it.
    protected String name;

    Animal(String name) {
        this.name = name;
    }

    String speak() {
        return "...";
    }

    /** Every Animal introduces itself the same way... */
    void introduce() {
        System.out.println(name + " the " + kind() + " says " + speak());
    }

    /** ...though each kind names itself. */
    String kind() {
        return "animal";
    }
}

/** extends Animal: a Dog starts as an Animal and changes two things. */
class Dog extends Animal {
    Dog(String name) {
        super(name);         // super(...) runs the Animal constructor
    }

    @Override
    String speak() {
        return "Woof";
    }

    @Override
    String kind() {
        return "dog";
    }

    /** Extra behaviour, which only a Dog has. */
    void fetch() {
        System.out.println(name + " fetches the ball.");
    }
}

class Cat extends Animal {
    Cat(String name) {
        super(name);
    }

    @Override
    String speak() {
        return "Meow";
    }

    @Override
    String kind() {
        return "cat";
    }
}
`

const EXAMPLE_7 = `import java.util.Scanner;

/**
 * Example 7: Methods and Parameters
 *
 * Breaking a program into named jobs. A method takes parameters, may return
 * a value, and can be called as many times as you like.
 */
public class Example7 {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);

        System.out.print("Enter your name: ");
        String name = input.nextLine();

        greet(name);           // returns nothing
        greet(name, 2);        // same name, different parameters: overloading
        System.out.println();

        int a = 12;
        int b = 30;

        System.out.println(a + " + " + b + " = " + add(a, b));
        System.out.println("The bigger one is " + biggest(a, b));

        int[] marks = { 8, 5, 9 };
        System.out.println("Average mark: " + average(marks));
    }

    /** void means it does something but hands nothing back. */
    static void greet(String who) {
        System.out.println("Hello, " + who + "!");
    }

    /** Overloading: the same name with a different parameter list. */
    static void greet(String who, int times) {
        for (int i = 0; i < times; i++) {
            System.out.println("Hello again, " + who + "!");
        }
    }

    /** int means it hands an int back, with return. */
    static int add(int x, int y) {
        return x + y;
    }

    static int biggest(int x, int y) {
        if (x > y) {
            return x;         // return leaves the method straight away
        }
        return y;
    }

    /** A whole array can be a parameter too. */
    static double average(int[] values) {
        int total = 0;
        for (int value : values) {
            total = total + value;
        }
        return (double) total / values.length;
    }
}
`

const EXAMPLE_8 = `import java.io.File;
import java.util.Scanner;

/**
 * Example 8: Errors and Checking Input
 *
 * try / catch lets a program carry on when something goes wrong, instead of
 * stopping. Typing something that is not a number is the usual case.
 *
 * Note: in this environment you can catch errors that Java code *throws* —
 * which includes everything below — but not the ones the machine raises by
 * itself, such as dividing by zero or reading past the end of an array. Those
 * stop the program. Check for them with an if instead.
 */
public class Example8 {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);

        int age = -1;

        // Keep asking until the answer makes sense.
        while (age < 0) {
            System.out.print("How old are you? ");
            String typed = input.nextLine();

            try {
                age = Integer.parseInt(typed);      // throws if it is not a number
                if (age < 0) {
                    System.out.println("  An age cannot be negative. Try again.");
                }
            } catch (NumberFormatException e) {
                // getMessage() describes what went wrong.
                System.out.println("  '" + typed + "' is not a whole number.");
                System.out.println("  (" + e.getMessage() + ")");
            }
        }

        System.out.println("Thank you. Next year you will be " + (age + 1) + ".");
        System.out.println();

        // ---- Throwing an error on purpose ----
        try {
            checkAge(age);
            System.out.println("That age passed the check.");
        } catch (Exception e) {
            System.out.println("Rejected: " + e.getMessage());
        } finally {
            // finally runs whether or not there was an error.
            System.out.println("Finished checking.");
        }
        System.out.println();

        // ---- An error from the library ----
        try {
            Scanner missing = new Scanner(new File("no_such_file.txt"));
            System.out.println(missing.nextLine());
        } catch (Exception e) {
            System.out.println("Could not open the file: " + e.getMessage());
        }
    }

    /** throw hands an error back to whoever called this method. */
    static void checkAge(int age) throws Exception {
        if (age > 150) {
            throw new Exception(age + " is older than anyone has ever been");
        }
    }
}
`

export const EXAMPLES: Example[] = [
  {
    id: 'ex1',
    label: 'Ex. 1: Simple Calculation',
    className: 'Example1',
    summary: 'Reading a number and doing arithmetic with it',
    source: EXAMPLE_1,
  },
  {
    id: 'ex2',
    label: 'Ex. 2: Basic Control Structures',
    className: 'Example2',
    summary: 'while, for, and if / else if / else',
    source: EXAMPLE_2,
  },
  {
    id: 'ex3',
    label: 'Ex. 3: Basic Data Structures',
    className: 'Example3',
    summary: 'Arrays, 2D arrays, ArrayList and HashMap',
    source: EXAMPLE_3,
  },
  {
    id: 'ex4',
    label: 'Ex. 4: File Writing & Reading',
    className: 'Example4',
    summary: 'Writing a data file and reading it back',
    source: EXAMPLE_4,
  },
  {
    id: 'ex5',
    label: 'Ex. 5: Multiple Classes',
    className: 'Example5',
    summary: 'Fields, constructors, methods and a second class',
    source: EXAMPLE_5,
  },
  {
    id: 'ex6',
    label: 'Ex. 6: Inheritance',
    className: 'Example6',
    summary: 'extends, super, @Override and polymorphism',
    source: EXAMPLE_6,
  },
  {
    id: 'ex7',
    label: 'Ex. 7: Methods & Parameters',
    className: 'Example7',
    summary: 'Parameters, return values and overloading',
    source: EXAMPLE_7,
  },
  {
    id: 'ex8',
    label: 'Ex. 8: Errors & Checking Input',
    className: 'Example8',
    summary: 'try / catch / finally, and validating what was typed',
    source: EXAMPLE_8,
  },
]

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find(example => example.id === id)
}

/** Where the example is written in the active filesystem. */
export function examplePath(example: Example): string {
  return `/${example.className}.java`
}
