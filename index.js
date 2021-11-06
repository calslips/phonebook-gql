const { ApolloServer, UserInputError, AuthenticationError, gql } = require('apollo-server-express')
const { ApolloServerPluginDrainHttpServer } = require('apollo-server-core')
const express = require('express')
const { createServer } = require('http')
const { execute, subscribe } = require('graphql')
const { SubscriptionServer } = require('subscriptions-transport-ws')
const { makeExecutableSchema } = require('@graphql-tools/schema')
const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')
const Person = require('./models/person')
const User = require('./models/user')

const { PubSub } = require('graphql-subscriptions')
const pubsub = new PubSub()

const { MONGODB_URI } = require('./config')
const JWT_SECRET = 'INSERT_SECRET_KEY'

console.log('connecting to', MONGODB_URI)

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false,
  useCreateIndex: true
})
  .then(() => {
    console.log('connected to MongoDB')
  })
  .catch((error) => {
    console.log('error connection to MongoDB', error.message)
  })

mongoose.set('debug', true)

const typeDefs = gql`
  type Address {
    street: String!
    city: String!
  }

  type Person {
    name: String!
    phone: String
    address: Address!
    friendOf: [User!]!
    id: ID!
  }

  enum YesNo {
    YES
    NO
  }

  type User {
    username: String!
    friends: [Person!]!
    id: ID!
  }

  type Token {
    value: String!
  }

  type Query {
    personCount: Int!
    allPersons(phone: YesNo): [Person!]!
    findPerson(name: String!): Person
    me: User
  }

  type Mutation {
    addPerson(
      name: String!
      phone: String
      street: String!
      city: String!
    ): Person
    editNumber(
      name: String!
      phone: String!
    ): Person
    createUser(
      username: String!
    ): User
    login(
      username: String!
      password: String!
    ): Token
    addAsFriend(
      name: String!
    ): User
  }

  type Subscription {
    personAdded: Person!
  }
`

const resolvers = {
  Query: {
    personCount: () => Person.collection.countDocuments(),
    allPersons: (root, args) => {
      if (!args.phone) {
        return Person.find({}).populate('friendOf')
      }
      return Person.find({ phone: { $exists: args.phone === 'YES' } })
        .populate('friendOf')
    },
    findPerson: (root, args) => Person.findOne({ name: args.name }),
    me: (root, args, context) => context.currentUser
  },
  Person: {
    address: (root) => {
      return {
        street: root.street,
        city: root.city
      }
    },
    // friendOf: async (root) => {
    //   const friends = await User.find({
    //     friends: {
    //       $in: [root._id]
    //     }
    //   })
    //   return friends
    // }
  },
  Mutation: {
    addPerson: async (root, args, context) => {
      const person = new Person({ ...args })
      const currentUser = context.currentUser
      person.friendOf = person.friendOf.concat(currentUser._id)

      if (!currentUser) {
        throw new AuthenticationError("not authenticated")
      }

      try {
        await person.save()
        currentUser.friends = currentUser.friends.concat(person)
        await currentUser.save()
      } catch (error) {
        throw new UserInputError(error.message, {
          invalidArgs: args
        })
      }
      pubsub.publish('PERSON_ADDED', { personAdded: person })

      return person
    },
    editNumber: async (root, args) => {
      const person = await Person.findOne({ name: args.name })
      person.phone = args.phone

      try {
        await person.save()
      } catch (error) {
        throw new UserInputError(error.message, {
          invalidArgs: args
        })
      }
      return person
    },
    createUser: (root, args) => {
      const user = new User({ username: args.username })

      return user.save()
        .catch(error => {
          throw new UserInputError(error.message, {
            invalidArgs: args
          })
        })
    },
    login: async (root, args) => {
      const user = await User.findOne({ username: args.username })

      if( !user || args.password !== 'secret' ) {
        throw new UserInputError('invalid credentials')
      }

      const tokenPayload = {
        username: user.username,
        id: user._id
      }

      return { value: jwt.sign(tokenPayload, JWT_SECRET)}
    },
    addAsFriend: async (root, args, { currentUser }) => {
      const notFriendYet = (person) =>
        !currentUser.friends.map((f) => f._id).includes(person._id)

      if (!currentUser) {
        throw new AuthenticationError("not authorized")
      }

      const person = await Person.findOne({ name: args.name })
      if (notFriendYet(person)) {
        currentUser.friends = currentUser.friends.concat(person)
      }

      await currentUser.save()
      return currentUser
    }
  },
  Subscription: {
    personAdded: {
      subscribe: () => pubsub.asyncIterator(['PERSON_ADDED'])
    }
  }
};

const startApolloServer = (async () => {
  const app = express()
  const httpServer = createServer(app)

  const schema = makeExecutableSchema({ typeDefs, resolvers })

  const subscriptionServer = SubscriptionServer.create(
    { schema, execute, subscribe },
    { server: httpServer, path: '/' }
  )

  const server = new ApolloServer({
    schema,
    plugins: [
      {
        async serverWillStart() {
          return {
            async drainServer() {
              subscriptionServer.close()
            }
          }
        }
      }
    ],
    context: async ({ req }) => {
      const auth = req ? req.headers.authorization : null
      if (auth && auth.toLowerCase().startsWith('bearer ')) {
        const decodedToken = jwt.verify(
          auth.split(' ')[1], JWT_SECRET
        )
        const currentUser = await User.findById(decodedToken.id).populate('friends')
        return { currentUser }
      }
    }
  });

  await server.start()
  server.applyMiddleware({
    app,
    path: '/'
  })

  await new Promise(resolve => httpServer.listen({ port: 4000 }, resolve))
  console.log(`Server ready at http://localhost:4000${server.graphqlPath}`)
})()